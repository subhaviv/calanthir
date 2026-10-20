/**
 * S3WorkloadDeployPipelineStack — a NON-self-mutating CodePipeline that deploys a
 * LOB's STANDALONE workload CDK app (bin/workload-app.ts) from an S3 source zip.
 *
 * WHY THIS EXISTS (and is separate from S3WorkloadPipelineStack):
 *   S3WorkloadPipelineStack uses aws-cdk-lib/pipelines.CodePipeline, which is
 *   SELF-MUTATING by design — it expects the synthesized source to CONTAIN the
 *   pipeline's own definition so it can reconfigure itself (AWS docs: selfMutation
 *   "needs to be true to allow the pipeline to reconfigure itself when assets or
 *   stages are added"). A LOB workload repo is a standalone app that defines only
 *   NetworkStack/AppStack — NOT this pipeline — so self-mutation always failed with
 *   "No stacks match <pipeline-stack>", and selfMutation:false broke asset publishing.
 *
 *   This construct instead uses a PLAIN aws-codepipeline.Pipeline with explicit
 *   CodeBuild actions. It never tries to own/rewrite itself; it just:
 *     Source(S3) -> Synth -> DeployNonprod -> EvaluationGate -> ProdApproval -> DeployProd
 *   Deploy actions run `cdk deploy '<Stage>/*'` so EVERY stack in the stage assembly
 *   is deployed in dependency order — add resources (CfnMemory, tables, buckets) to
 *   AppStack and they deploy with zero pipeline changes.
 *
 *   Cross-account deploy uses the workload account's standard CDK bootstrap roles
 *   (cdk-hnb659fds-{deploy,cfn-exec,file-publishing}-role); the pipeline's CodeBuild
 *   role is granted sts:AssumeRole on them.
 *
 * Scope: the simple runtime path (no GA Registry / enablePipelineRuntimeMemory).
 *   Memory is added as a CfnMemory resource INSIDE the workload AppStack, not via
 *   the heavy registry-orchestrated foundation.
 *
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */
import { Duration, Stack, StackProps } from "aws-cdk-lib";
import {
  Artifact,
  Pipeline,
  PipelineType,
} from "aws-cdk-lib/aws-codepipeline";
import {
  CodeBuildAction,
  ManualApprovalAction,
  S3SourceAction,
  S3Trigger,
} from "aws-cdk-lib/aws-codepipeline-actions";
import {
  BuildSpec,
  LinuxBuildImage,
  PipelineProject,
} from "aws-cdk-lib/aws-codebuild";
import { Bucket, IBucket } from "aws-cdk-lib/aws-s3";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

const BOOTSTRAP_QUALIFIER = "hnb659fds";

export interface S3WorkloadDeployPipelineStackProps extends StackProps {
  /** Existing tenant source bucket NAME (created at LOB-onboard by LobSourceBucket). */
  readonly sourceBucketName: string;
  /** Per-agent object key, e.g. "<agentId>/workload-source.zip". */
  readonly sourceObjectKey: string;

  readonly tenantId: string;
  readonly agentId: string;
  readonly costCentre: string;

  readonly workloadNonprodEnv: { account: string; region: string };
  readonly workloadProdEnv: { account: string; region: string };
  readonly workloadNonprodAvailabilityZones: readonly string[];
  readonly workloadProdAvailabilityZones: readonly string[];

  /** Context forwarded verbatim to the workload app's `cdk synth`/`cdk deploy`. */
  readonly synthContext?: Record<string, string>;

  /** Stage assembly ids produced by bin/workload-app.ts (pipeline mode). */
  readonly nonprodStageId?: string; // default "agentops-Workload-Nonprod"
  readonly prodStageId?: string; // default "agentops-Workload-Prod"

  /** EvaluationGate: path to the agent's eval script inside the source. */
  readonly evaluationScriptPath?: string; // default "scripts/evaluation_gate.py"
}

export class S3WorkloadDeployPipelineStack extends Stack {
  readonly pipeline: Pipeline;

  constructor(
    scope: Construct,
    id: string,
    props: S3WorkloadDeployPipelineStackProps,
  ) {
    super(scope, id, props);

    const nonprodStageId = props.nonprodStageId ?? "agentops-Workload-Nonprod";
    const prodStageId = props.prodStageId ?? "agentops-Workload-Prod";
    const region = this.region;

    const sourceBucket: IBucket = Bucket.fromBucketName(
      this,
      "SourceBucket",
      props.sourceBucketName,
    );

    const contextArgs = this.renderContextArgs(props);

    // Bootstrap roles the CDK CLI assumes to deploy into each workload account.
    const bootstrapRoleArns = (account: string): string[] => [
      `arn:aws:iam::${account}:role/cdk-${BOOTSTRAP_QUALIFIER}-deploy-role-${account}-${region}`,
      `arn:aws:iam::${account}:role/cdk-${BOOTSTRAP_QUALIFIER}-file-publishing-role-${account}-${region}`,
      `arn:aws:iam::${account}:role/cdk-${BOOTSTRAP_QUALIFIER}-lookup-role-${account}-${region}`,
      `arn:aws:iam::${account}:role/cdk-${BOOTSTRAP_QUALIFIER}-cfn-exec-role-${account}-${region}`,
    ];
    const assumeRoleArns = Array.from(
      new Set([
        ...bootstrapRoleArns(props.workloadNonprodEnv.account),
        ...bootstrapRoleArns(props.workloadProdEnv.account),
      ]),
    );

    // ── Artifacts ────────────────────────────────────────────────────────────
    const sourceArtifact = new Artifact("Source");
    const cloudAssembly = new Artifact("CloudAssembly");

    // ── Synth project: build + synth the workload app into cdk.out ─────────────
    const synthProject = new PipelineProject(this, "SynthProject", {
      environment: { buildImage: LinuxBuildImage.STANDARD_7_0 },
      buildSpec: BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: { "runtime-versions": { nodejs: "22" } },
          build: {
            commands: [
              "set -eu",
              "npm ci",
              "npm run build",
              "npm test",
              `npx cdk synth --context stage=pipeline --context agenticai/pipelineSelection=workload ${contextArgs}`,
              "test -f cdk.out/manifest.json",
            ],
          },
        },
        artifacts: { "base-directory": "cdk.out", files: ["**/*"] },
      }),
      timeout: Duration.minutes(30),
    });

    // ── Deploy project (reused for nonprod + prod via env var) ─────────────────
    const deployProject = new PipelineProject(this, "DeployProject", {
      environment: { buildImage: LinuxBuildImage.STANDARD_7_0 },
      buildSpec: BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: { "runtime-versions": { nodejs: "22" } },
          build: {
            commands: [
              "set -eu",
              // The input artifact is the prebuilt cloud assembly (cdk.out) from Synth
              // — there is NO package.json/lock here, so do NOT run `npm ci`. Install
              // only the CDK CLI and deploy every stack in the target stage.
              "npm install -g aws-cdk@2",
              'cdk deploy "$TARGET_STAGE/*" --app . --require-approval never --concurrency 1',
            ],
          },
        },
      }),
      timeout: Duration.minutes(60),
    });
    deployProject.addToRolePolicy(
      new PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: assumeRoleArns,
      }),
    );

    // ── Evaluation gate project ────────────────────────────────────────────────
    const evalScript = props.evaluationScriptPath ?? "scripts/evaluation_gate.py";
    const evalProject = new PipelineProject(this, "EvaluationGateProject", {
      environment: { buildImage: LinuxBuildImage.STANDARD_7_0 },
      buildSpec: BuildSpec.fromObject({
        version: "0.2",
        phases: {
          build: {
            commands: [
              "set -eu",
              `if [ ! -f ${evalScript} ]; then echo "ERROR: ${evalScript} missing; evaluation gate cannot pass"; exit 1; fi`,
              'python3 -m pip install --disable-pip-version-check "boto3==1.43.98"',
              `python3 ${evalScript}`,
            ],
          },
        },
      }),
      timeout: Duration.minutes(30),
    });

    // ── Pipeline ───────────────────────────────────────────────────────────────
    this.pipeline = new Pipeline(this, "Pipeline", {
      pipelineName: `agenticai-workload-s3-${props.tenantId}-${props.agentId}`,
      pipelineType: PipelineType.V2,
      crossAccountKeys: true,
      enableKeyRotation: true,
      restartExecutionOnUpdate: true,
      stages: [
        {
          stageName: "Source",
          actions: [
            new S3SourceAction({
              actionName: "S3Source",
              bucket: sourceBucket,
              bucketKey: props.sourceObjectKey,
              output: sourceArtifact,
              trigger: S3Trigger.EVENTS,
            }),
          ],
        },
        {
          stageName: "Synth",
          actions: [
            new CodeBuildAction({
              actionName: "Synth",
              project: synthProject,
              input: sourceArtifact,
              outputs: [cloudAssembly],
            }),
          ],
        },
        {
          stageName: "Nonprod",
          actions: [
            new CodeBuildAction({
              actionName: "DeployNonprod",
              project: deployProject,
              input: cloudAssembly,
              environmentVariables: {
                TARGET_STAGE: { value: nonprodStageId },
              },
            }),
          ],
        },
        {
          stageName: "EvaluationGate",
          actions: [
            new CodeBuildAction({
              actionName: "EvaluationGate",
              project: evalProject,
              input: sourceArtifact,
            }),
          ],
        },
        {
          stageName: "ProdApproval",
          actions: [
            new ManualApprovalAction({
              actionName: "ProdApproval",
              additionalInformation:
                "Nonprod deployed and the evaluation gate passed. Approve to deploy Prod.",
            }),
          ],
        },
        {
          stageName: "Prod",
          actions: [
            new CodeBuildAction({
              actionName: "DeployProd",
              project: deployProject,
              input: cloudAssembly,
              environmentVariables: {
                TARGET_STAGE: { value: prodStageId },
              },
            }),
          ],
        },
      ],
    });

    NagSuppressions.addStackSuppressions(
      this,
      [
        { id: "AwsSolutions-IAM5", reason: "SEC-011: CDK deploy requires bootstrap-role wildcards." },
        { id: "AwsSolutions-CB4", reason: "SEC-017: CodeBuild artifacts flow through the pipeline KMS key." },
        { id: "AwsSolutions-S1", reason: "SEC-001: pipeline artifact bucket is short-lived; CloudTrail + pipeline history are the audit trail." },
        { id: "NIST.800.53.R5-CodeBuildProjectKMSEncryptedArtifacts", reason: "SEC-017: artifact bucket uses a customer-managed KMS key." },
        { id: "NIST.800.53.R5-CodeBuildProjectPrivilegedModeDisabled", reason: "SEC-019: synth/deploy run in standard non-privileged containers." },
        { id: "NIST.800.53.R5-CodeBuildProjectSourceRepoUrl", reason: "SEC-020: source is a versioned S3 object from the LOB CI job." },
        { id: "NIST.800.53.R5-IAMNoInlinePolicy", reason: "SEC-005: one pipeline-owned statement assumes only the exact bootstrap roles." },
        { id: "NIST.800.53.R5-S3BucketLoggingEnabled", reason: "SEC-001: short-lived pipeline artifact bucket; CloudTrail + pipeline history are the audit trail." },
        { id: "NIST.800.53.R5-S3BucketReplicationEnabled", reason: "SEC-002: CRR deferred to the DR roadmap; artifacts are rebuildable per execution." },
        { id: "NIST.800.53.R5-S3BucketVersioningEnabled", reason: "SEC-022: artifacts are immutable per execution and expire; versioning adds no recovery value." },
      ],
      true,
    );
  }

  private renderContextArgs(
    props: S3WorkloadDeployPipelineStackProps,
  ): string {
    const ctx: Record<string, string> = {
      // synthContext (e.g. the platform-wide sharedSynthContext) goes FIRST so the
      // authoritative per-agent identity below OVERRIDES it. sharedSynthContext
      // carries platform defaults like tenantId=calanthir — without this ordering
      // those would clobber this agent's real tenant/agent and the workload app would
      // synth the wrong resource names (e.g. log group /agenticai/nonprod/calanthir/primary).
      ...(props.synthContext ?? {}),
      "agenticai/tenantId": props.tenantId,
      "agenticai/agentId": props.agentId,
      "agenticai/applicationId": `aifactory-${props.tenantId}`,
      "agenticai/costCentre": props.costCentre,
      "agenticai/workloadNonprodAccountId": props.workloadNonprodEnv.account,
      "agenticai/workloadProdAccountId": props.workloadProdEnv.account,
      "agenticai/workloadNonprodAvailabilityZones": JSON.stringify(
        props.workloadNonprodAvailabilityZones,
      ),
      "agenticai/workloadProdAvailabilityZones": JSON.stringify(
        props.workloadProdAvailabilityZones,
      ),
      "agenticai/defaultRegion": this.region,
    };
    return Object.keys(ctx)
      .sort()
      .map((k) => `--context ${k}='${ctx[k].replace(/'/g, `'\\''`)}'`)
      .join(" ");
  }
}
