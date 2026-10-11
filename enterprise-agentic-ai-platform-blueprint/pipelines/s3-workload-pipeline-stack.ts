/**
 * S3WorkloadPipelineStack — per-application pipeline sourced from S3.
 *
 * Identical promotion contract to WorkloadPipelineStack but uses an S3 object
 * as the pipeline source instead of a GitHub/CodeConnections connection. This
 * variant is intended for LOB teams whose source lives in a self-managed VCS
 * (e.g. on-prem GitLab) that cannot be reached directly from CodePipeline.
 *
 * Usage pattern:
 *   1. A CI job in the LOB VCS zips the repository and uploads it to the
 *      source bucket on every merge to the trunk branch.
 *   2. CodePipeline triggers automatically off the new S3 object version.
 *   3. Everything from Synth onward is identical to WorkloadPipelineStack.
 *
 * The source bucket must have versioning enabled — CodePipelineSource.s3()
 * requires it and CDK enforces this at synthesis time.
 *
 * Pipeline stages (identical to WorkloadPipelineStack):
 *
 *   Source (S3) → Synth → Deploy(workload-nonprod)
 *     → EvaluationGate → ProdApproval → CanaryDeploy → CanarySoak
 *     → Deploy(workload-prod)
 *
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */
import {
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { PipelineType } from "aws-cdk-lib/aws-codepipeline";
import {
  BuildSpec,
  LinuxArmBuildImage,
  LinuxBuildImage,
} from "aws-cdk-lib/aws-codebuild";
import { Bucket, BucketEncryption, BlockPublicAccess, IBucket } from "aws-cdk-lib/aws-s3";
import { ArnPrincipal, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  CodeBuildStep,
  CodePipeline,
  CodePipelineSource,
  ManualApprovalStep,
  ShellStep,
  Step,
} from "aws-cdk-lib/pipelines";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

import {
  WorkloadDeploymentStage,
  WorkstreamRegistryRolesStage,
  type WorkloadGaRegistryConfig,
  type WorkloadPolicyEngineConfig,
  type GeneratedAgentInferenceInputs,
} from "./workload-pipeline-stack";
import type { AgentCoreRuntimeJwtAuthorizerProps } from "@agenticai/agentcore-runtime";
import { gatewayModelPrice } from "@agenticai/platform-baselines";
import {
  applyPipelineResourceTags,
  createPipelineArtifactBucket,
  type PipelineResourceTags,
} from "./pipeline-artifacts";
import {
  enterBlueprintSourceDirectory,
  stageAwareSynthCommands,
} from "./synth-commands";
import type { GaRegistryConsumerContext } from "@agenticai/agent-registry";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function registryResolverCommand(
  context: GaRegistryConsumerContext,
  outputVariable: string,
  applicationId: string,
  tenantId: string,
  agentId: string,
  costCentre: string,
): string {
  const expectedTools = context.records
    .map((record) => record.document.toolId)
    .map((toolId) => `--expected-tool-id ${shellQuote(toolId)}`)
    .join(" ");
  const outputName = `.agenticai-ga-registry-${context.environment}.json`;
  const invocation = [
    '"$PWD/.agenticai-ga-resolver-venv/bin/python"',
    "pipelines/resolve_ga_registry_context.py",
    "--assume-reader",
    `--account-id ${shellQuote(context.platformAccountId)}`,
    `--region ${shellQuote(context.region)}`,
    `--environment ${shellQuote(context.environment)}`,
    `--application-id ${shellQuote(applicationId)}`,
    `--agent-id ${shellQuote(agentId)}`,
    `--tenant-id ${shellQuote(tenantId)}`,
    `--cost-centre ${shellQuote(costCentre)}`,
    expectedTools,
    '--source-revision "${CODEBUILD_RESOLVED_SOURCE_VERSION:-}"',
    `--output "$${outputVariable}"`,
  ].join(" ");
  return (
    `${outputVariable}="$PWD/${outputName}"; ` +
    `export ${outputVariable}; ` +
    invocation
  );
}

function registrySynthRoleName(tenantId: string, agentId: string): string {
  const name = `AgenticAI-WLP-${tenantId}-${agentId}-RegistrySynth`;
  if (name.length > 64 || !/^[A-Za-z0-9+=,.@_-]+$/.test(name)) {
    throw new Error(
      "S3WorkloadPipelineStack: tenantId/agentId produce an invalid Registry synth role name.",
    );
  }
  return name;
}

function evaluationCodeBuildRoleName(
  tenantId: string,
  agentId: string,
): string {
  const name = `AgenticAI-WLP-${tenantId}-${agentId}-Evaluation`;
  if (name.length > 64 || !/^[A-Za-z0-9+=,.@_-]+$/.test(name)) {
    throw new Error(
      "S3WorkloadPipelineStack: tenantId/agentId produce an invalid evaluation role name.",
    );
  }
  return name;
}

function evaluationInvokerRoleName(tenantId: string, agentId: string): string {
  const name = `AgenticAI-D03-nonprod-${tenantId}-${agentId}-evaluation`;
  if (name.length > 64 || !/^[A-Za-z0-9+=,.@_-]+$/.test(name)) {
    throw new Error(
      "S3WorkloadPipelineStack: tenantId/agentId produce an invalid evaluation invoker role name.",
    );
  }
  return name;
}

export interface S3WorkloadPipelineStackProps extends StackProps {
  /**
   * S3 bucket holding the versioned source zip. Must have versioning enabled.
   * When omitted the stack creates a bucket named
   * `agenticai-pipeline-source-<tenantId>` automatically.
   */
  readonly sourceBucket?: IBucket;
  /**
   * S3 object key of the source zip within the bucket.
   * Example: "workload-source.zip"
   */
  readonly sourceObjectKey: string;
  /**
   * IAM role ARN of the LOB CI runner that uploads the source zip.
   * When provided, an s3:PutObject grant is added to the source bucket.
   * Can be omitted now and the stack updated later once the role exists.
   */
  readonly ciRunnerRoleArn?: string;

  readonly tenantId: string;
  readonly agentId: string;
  readonly applicationId?: string;
  readonly costCentre: string;
  readonly gaRegistry?: WorkloadGaRegistryConfig;
  readonly policyEngine?: WorkloadPolicyEngineConfig;
  readonly enablePipelineRuntimeMemory?: boolean;
  readonly agentImageVariant?: "compatibility" | "generated-agent";
  readonly generatedAgentInference?: {
    readonly nonprod: GeneratedAgentInferenceInputs;
    readonly prod: GeneratedAgentInferenceInputs;
  };
  readonly workloadNonprodEnv: { account: string; region: string };
  readonly workloadProdEnv: { account: string; region: string };
  readonly workloadNonprodAvailabilityZones: readonly string[];
  readonly workloadProdAvailabilityZones: readonly string[];
  readonly auditOamSinkArn?: string;
  readonly notificationEmail?: string;
  readonly benefitsQaImageUri?: string;
  readonly benefitsQaJwtAuthorizer?: AgentCoreRuntimeJwtAuthorizerProps;
  readonly inferenceM2mSecretArn?: string;
  readonly inferenceGatewayUrl?: string;
  readonly inferenceModelId?: string;

  readonly evalRegressionPassRate?: number;
  readonly evalGuardrailViolationRate?: number;
  readonly evalQualityScoreMin?: number;
  readonly evalToolSuccessRate?: number;
  readonly evalFirstTokenP99Ms?: number;
  readonly evalRefusalRateMin?: number;
  readonly evalCostPerPromptMaxUsd?: number;
  readonly canaryPercent?: number;
  readonly canarySoakMinutes?: number;
  readonly synthStage?: string;
  readonly synthContext?: Record<string, string>;
  readonly canaryDeployCommands?: readonly string[];
}

export class S3WorkloadPipelineStack extends Stack {
  readonly pipeline: CodePipeline;

  constructor(
    scope: Construct,
    id: string,
    props: S3WorkloadPipelineStackProps,
  ) {
    super(scope, id, props);

    const applicationId = props.applicationId ?? props.tenantId;

    if (props.gaRegistry) {
      const { nonprod, prod, gatewayRegion } = props.gaRegistry;
      if (nonprod.environment !== "nonprod" || prod.environment !== "prod") {
        throw new Error(
          "S3WorkloadPipelineStack: GA Registry contexts must match nonprod/prod stages.",
        );
      }
      if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(gatewayRegion)) {
        throw new Error(
          "S3WorkloadPipelineStack: gaRegistry.gatewayRegion is invalid.",
        );
      }
      const nonprodTools = nonprod.records.map((r) => r.document.toolId);
      const prodTools = prod.records.map((r) => r.document.toolId);
      if (JSON.stringify(nonprodTools) !== JSON.stringify(prodTools)) {
        throw new Error(
          "S3WorkloadPipelineStack: nonprod/prod GA Registry tool sets must match.",
        );
      }
    }

    if (props.policyEngine) {
      if (!props.gaRegistry) {
        throw new Error(
          "S3WorkloadPipelineStack: PolicyEngine requires GA Registry mode.",
        );
      }
      if (!(["LOG_ONLY", "ENFORCE"] as const).includes(props.policyEngine.mode)) {
        throw new Error(
          "S3WorkloadPipelineStack: PolicyEngine mode must be LOG_ONLY or ENFORCE.",
        );
      }
      if (
        props.policyEngine.nonprodIamRoleArns.length === 0 ||
        props.policyEngine.prodIamRoleArns.length === 0
      ) {
        throw new Error(
          "S3WorkloadPipelineStack: PolicyEngine requires exact IAM role ARNs for both environments.",
        );
      }
    }

    if (props.enablePipelineRuntimeMemory && !props.gaRegistry) {
      throw new Error(
        "S3WorkloadPipelineStack: Runtime+Memory foundation requires GA Registry mode.",
      );
    }

    const resourceTags: PipelineResourceTags = {
      applicationId,
      agentId: props.agentId,
      tenantId: props.tenantId,
      costCentre: props.costCentre,
      environment: "pipeline",
    };
    applyPipelineResourceTags(this, resourceTags);

    const evaluationEnabled =
      props.enablePipelineRuntimeMemory === true &&
      props.agentImageVariant === "generated-agent";
    const pipelineAccount = props.env?.account;
    if (
      evaluationEnabled &&
      (typeof pipelineAccount !== "string" || !/^\d{12}$/.test(pipelineAccount))
    ) {
      throw new Error(
        "S3WorkloadPipelineStack: generated-agent evaluation requires a concrete 12-digit pipeline account.",
      );
    }

    const evaluationRoleName = evaluationCodeBuildRoleName(
      props.tenantId,
      props.agentId,
    );
    const evaluationRoleArn = evaluationEnabled
      ? `arn:aws:iam::${pipelineAccount}:role/${evaluationRoleName}`
      : "";
    const evaluationInvokerArn = `arn:aws:iam::${props.workloadNonprodEnv.account}:role/${evaluationInvokerRoleName(props.tenantId, props.agentId)}`;

    const evaluationRole = evaluationEnabled
      ? new Role(this, "EvaluationCodeBuildRole", {
          roleName: evaluationRoleName,
          assumedBy: new ServicePrincipal("codebuild.amazonaws.com"),
          description:
            "Pipeline role that assumes only the nonproduction Workstream evaluation invoker.",
        })
      : undefined;
    if (evaluationRole) {
      evaluationRole.addToPolicy(
        new PolicyStatement({
          actions: ["sts:AssumeRole"],
          resources: [evaluationInvokerArn],
        }),
      );
      NagSuppressions.addResourceSuppressions(evaluationRole, [
        {
          id: "NIST.800.53.R5-IAMNoInlinePolicy",
          reason:
            "SEC-005: one pipeline-owned statement assumes only the exact Workstream evaluation role; a shared policy would widen the boundary.",
        },
      ]);
    }

    const artifactBucket = createPipelineArtifactBucket(
      this,
      "S3WorkloadPipelineArtifacts",
      resourceTags,
    );

    // S3 source bucket — created here if not passed in externally.
    const sourceBucket: IBucket = props.sourceBucket ?? (() => {
      const bucket = new Bucket(this, "SourceBucket", {
        bucketName: `agenticai-pipeline-source-${props.tenantId}`,
        versioned: true,
        encryption: BucketEncryption.S3_MANAGED,
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        removalPolicy: RemovalPolicy.RETAIN,
        enforceSSL: true,
      });
      if (props.ciRunnerRoleArn) {
        bucket.addToResourcePolicy(new PolicyStatement({
          principals: [new ArnPrincipal(props.ciRunnerRoleArn)],
          actions: ["s3:PutObject", "s3:GetBucketVersioning"],
          resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
        }));
      }
      return bucket;
    })();

    const source = CodePipelineSource.s3(
      sourceBucket,
      props.sourceObjectKey,
    );

    const baseSynthOptions = {
      stage: props.synthStage ?? "pipeline",
      context: this.synthContext(props),
      expectedStackArtifactId: this.stackName,
      expectedStageAssemblyGlobs: props.gaRegistry
        ? [
            "cdk.out/assembly-*RegistryRoles",
            "cdk.out/assembly-*Nonprod",
            "cdk.out/assembly-*Prod",
          ]
        : ["cdk.out/assembly-*Nonprod", "cdk.out/assembly-*Prod"],
    };

    let synthStep: ShellStep;
    if (props.gaRegistry) {
      const resolver = {
        commands: [
          "if [ -f package.json ] && [ -d pipelines ]; then :; " +
            "elif [ -f enterprise-agentic-ai-platform-blueprint/package.json ]; then " +
            "cd enterprise-agentic-ai-platform-blueprint; " +
            'else echo "ERROR: blueprint package not found for GA resolver"; exit 1; fi',
          'python3 -m venv "$PWD/.agenticai-ga-resolver-venv"',
          '"$PWD/.agenticai-ga-resolver-venv/bin/pip" install --disable-pip-version-check -r pipelines/requirements-ga-registry-resolver.txt',
          registryResolverCommand(
            props.gaRegistry.nonprod,
            "GA_REGISTRY_NONPROD_CONTEXT_FILE",
            applicationId,
            props.tenantId,
            props.agentId,
            props.costCentre,
          ),
          registryResolverCommand(
            props.gaRegistry.prod,
            "GA_REGISTRY_PROD_CONTEXT_FILE",
            applicationId,
            props.tenantId,
            props.agentId,
            props.costCentre,
          ),
        ],
        contextFromEnvironment: {
          "agenticai/gaRegistryNonprodContextFile":
            "GA_REGISTRY_NONPROD_CONTEXT_FILE",
          "agenticai/gaRegistryProdContextFile": "GA_REGISTRY_PROD_CONTEXT_FILE",
        },
      };

      const synthRole = new Role(this, "RegistrySynthRole", {
        roleName: registrySynthRoleName(props.tenantId, props.agentId),
        assumedBy: new ServicePrincipal("codebuild.amazonaws.com"),
        description:
          "Workload pipeline synth role; may assume only the two environment RegistryReader roles.",
      });
      synthRole.addToPolicy(
        new PolicyStatement({
          actions: ["sts:AssumeRole"],
          resources: [
            props.gaRegistry.nonprod.readerRoleArn,
            props.gaRegistry.prod.readerRoleArn,
          ],
        }),
      );

      synthStep = new CodeBuildStep("Synth", {
        input: source,
        role: synthRole,
        commands: stageAwareSynthCommands({
          ...baseSynthOptions,
          preSynthCommands: resolver.commands,
          contextFromEnvironment: resolver.contextFromEnvironment,
        }),
      });
    } else {
      synthStep = new ShellStep("Synth", {
        input: source,
        commands: stageAwareSynthCommands(baseSynthOptions),
      });
    }

    this.pipeline = new CodePipeline(this, "S3WorkloadPipeline", {
      artifactBucket,
      pipelineName: `agenticai-workload-s3-${props.tenantId}-${props.agentId}`,
      pipelineType: PipelineType.V2,
      crossAccountKeys: true,
      enableKeyRotation: true,
      synth: synthStep,
      publishAssetsInParallel: false,
      ...(props.enablePipelineRuntimeMemory
        ? {
            assetPublishingCodeBuildDefaults: {
              buildEnvironment: {
                buildImage: LinuxArmBuildImage.fromCodeBuildImageId(
                  "aws/codebuild/amazonlinux-aarch64-standard:4.0",
                ),
              },
            },
          }
        : {}),
    });

    if (props.gaRegistry) {
      const rolesStage = new WorkstreamRegistryRolesStage(
        this,
        "RegistryRoles",
        {
          tenantId: props.tenantId,
          agentId: props.agentId,
          applicationId,
          costCentre: props.costCentre,
          gatewayRegion: props.gaRegistry.gatewayRegion,
          workloadNonprodAccountId: props.workloadNonprodEnv.account,
          workloadProdAccountId: props.workloadProdEnv.account,
          auditOamSinkArn: props.auditOamSinkArn,
          nonprodContext: props.gaRegistry.nonprod,
          prodContext: props.gaRegistry.prod,
          enablePipelineRuntimeMemory: props.enablePipelineRuntimeMemory,
          generatedAgentM2mSecretArns: props.generatedAgentInference
            ? {
                nonprod: props.generatedAgentInference.nonprod.m2mSecretArn,
                prod: props.generatedAgentInference.prod.m2mSecretArn,
              }
            : undefined,
        },
      );

      const gatewayPermissionReady = new ManualApprovalStep(
        "GatewayPermissionReady",
        {
          comment: props.enablePipelineRuntimeMemory
            ? "Stable Gateway and Runtime roles exist. Continue only after the Platform pipeline granted every tool alias to both GatewayServiceRoleArn outputs and each alias policy names the role ARN (not a stale AROA principal); the pipeline then enforces the AgentCore propagation window."
            : "Stable Workstream roles exist. Continue only after the Platform pipeline granted every tool alias to both GatewayServiceRoleArn outputs and each alias policy names the role ARN (not a stale AROA principal).",
        },
      );
      const postSteps: Step[] = [gatewayPermissionReady];
      if (props.enablePipelineRuntimeMemory) {
        const runtimeRolePropagation = new CodeBuildStep(
          "RuntimeRolePropagation",
          {
            commands: [
              'echo "Waiting six minutes for the stable Runtime role to propagate to AgentCore"',
              "sleep 360",
            ],
            buildEnvironment: { buildImage: LinuxBuildImage.STANDARD_7_0 },
            timeout: Duration.minutes(10),
          },
        );
        runtimeRolePropagation.addStepDependency(gatewayPermissionReady);
        postSteps.push(runtimeRolePropagation);
      }
      this.pipeline.addStage(rolesStage, { post: postSteps });
    }

    const nonprodStage = new WorkloadDeploymentStage(this, "Nonprod", {
      env: props.workloadNonprodEnv,
      envName: "nonprod",
      tenantId: props.tenantId,
      agentId: props.agentId,
      applicationId,
      costCentre: props.costCentre,
      availabilityZones: props.workloadNonprodAvailabilityZones,
      gaRegistryContext: props.gaRegistry?.nonprod,
      gatewayRegion: props.gaRegistry?.gatewayRegion,
      policyEngineMode: props.policyEngine?.mode,
      policyEngineIamRoleArns: props.policyEngine?.nonprodIamRoleArns,
      enablePipelineRuntimeMemory: props.enablePipelineRuntimeMemory,
      agentImageVariant: props.agentImageVariant,
      generatedAgentInference: props.generatedAgentInference?.nonprod,
      evaluationInvokerPrincipalArn: evaluationEnabled
        ? evaluationRoleArn
        : undefined,
      auditOamSinkArn: props.auditOamSinkArn,
      notificationEmail: props.notificationEmail,
      benefitsQaImageUri: props.benefitsQaImageUri,
      benefitsQaJwtAuthorizer: props.benefitsQaJwtAuthorizer,
      inferenceM2mSecretArn: props.inferenceM2mSecretArn,
      inferenceGatewayUrl: props.inferenceGatewayUrl,
      inferenceModelId: props.inferenceModelId,
    });
    this.pipeline.addStage(nonprodStage);

    const evaluationRuntimeStack = evaluationEnabled
      ? nonprodStage.runtimeMemoryStack
      : undefined;
    if (evaluationEnabled && !evaluationRuntimeStack) {
      throw new Error(
        "S3WorkloadPipelineStack: generated-agent evaluation requires the nonproduction RuntimeMemory stack.",
      );
    }
    const evaluationRegion =
      props.gaRegistry?.gatewayRegion ?? props.workloadNonprodEnv.region;
    const evaluationPrice = evaluationEnabled
      ? gatewayModelPrice(
          evaluationRegion,
          props.generatedAgentInference?.nonprod.modelId ?? "",
        )
      : undefined;

    const evalStep = new CodeBuildStep("EvaluationGate", {
      commands: [
        "set -eu",
        enterBlueprintSourceDirectory(),
        'echo "Evaluation gate thresholds:"',
        `echo "  regression_pass_rate_min_pct     = ${props.evalRegressionPassRate ?? 95}"`,
        `echo "  guardrail_violation_rate_max_pct = ${props.evalGuardrailViolationRate ?? 1}"`,
        `echo "  quality_score_min_pct            = ${props.evalQualityScoreMin ?? 85}"`,
        `echo "  tool_success_rate_min_pct        = ${props.evalToolSuccessRate ?? 98}"`,
        `echo "  first_token_p99_max_ms           = ${props.evalFirstTokenP99Ms ?? 1500}"`,
        `echo "  refusal_rate_min_pct             = ${props.evalRefusalRateMin ?? 99}"`,
        `echo "  cost_per_prompt_max_usd          = ${props.evalCostPerPromptMaxUsd ?? 0.05}"`,
        'if [ ! -f scripts/evaluation_gate.py ]; then echo "ERROR: scripts/evaluation_gate.py is missing; evaluation gate cannot pass"; exit 1; fi',
        ...(evaluationRuntimeStack
          ? [
              'python3 -m pip install --disable-pip-version-check "boto3==1.43.98"',
              "python3 scripts/evaluation_gate.py",
            ]
          : [
              'echo "ERROR: evaluation requires enablePipelineRuntimeMemory=true and agentImageVariant=generated-agent" >&2; exit 1',
            ]),
      ],
      ...(evaluationRole ? { role: evaluationRole } : {}),
      ...(evaluationRuntimeStack
        ? {
            envFromCfnOutputs: {
              EVAL_RUNTIME_ARN: evaluationRuntimeStack.runtimeArnOutput,
            },
          }
        : {}),
      partialBuildSpec: BuildSpec.fromObject({
        version: "0.2",
        env: {
          variables: {
            EVAL_REGRESSION_PASS_MIN_PCT: String(
              props.evalRegressionPassRate ?? 95,
            ),
            EVAL_GUARDRAIL_VIOLATION_MAX_PCT: String(
              props.evalGuardrailViolationRate ?? 1,
            ),
            EVAL_QUALITY_MIN_PCT: String(props.evalQualityScoreMin ?? 85),
            EVAL_TOOL_SUCCESS_MIN_PCT: String(props.evalToolSuccessRate ?? 98),
            EVAL_FIRST_TOKEN_P99_MAX_MS: String(
              props.evalFirstTokenP99Ms ?? 1500,
            ),
            EVAL_REFUSAL_RATE_MIN_PCT: String(props.evalRefusalRateMin ?? 99),
            EVAL_COST_PER_PROMPT_MAX_USD: String(
              props.evalCostPerPromptMaxUsd ?? 0.05,
            ),
            EVAL_TENANT: props.tenantId,
            EVAL_AGENT: props.agentId,
            EVAL_ENV: "nonprod",
            EVAL_REGION: evaluationRegion,
            EVAL_INVOKER_ROLE_ARN: evaluationInvokerArn,
            EVAL_PRICE_IN_PER_1K: evaluationPrice
              ? String(evaluationPrice.inputUsdPer1kTokens)
              : "",
            EVAL_PRICE_OUT_PER_1K: evaluationPrice
              ? String(evaluationPrice.outputUsdPer1kTokens)
              : "",
          },
        },
      }),
      buildEnvironment: { buildImage: LinuxBuildImage.STANDARD_7_0 },
      timeout: Duration.minutes(30),
    });

    const canaryPercent = props.canaryPercent ?? 5;
    const canarySoakMinutes = props.canarySoakMinutes ?? 30;
    const onlineEvalAlarmName = `agenticai-online-eval-nonprod-${props.tenantId}-${props.agentId}`;
    const describeAlarmState =
      `aws cloudwatch describe-alarms --alarm-names ${onlineEvalAlarmName}` +
      ` --alarm-types CompositeAlarm --query 'CompositeAlarms[0].StateValue' --output text`;

    const canaryDeployStep = new CodeBuildStep("CanaryDeploy", {
      commands: this.canaryDeployCommands(props, canaryPercent),
      partialBuildSpec: BuildSpec.fromObject({
        version: "0.2",
        env: { variables: { CANARY_PERCENT: String(canaryPercent) } },
      }),
      buildEnvironment: { buildImage: LinuxBuildImage.STANDARD_7_0 },
      timeout: Duration.minutes(15),
    });

    const canarySoakStep = new CodeBuildStep("CanarySoak", {
      commands: [
        "set -eu",
        `echo "Soaking canary ${canarySoakMinutes} minutes against composite alarm ${onlineEvalAlarmName}"`,
        `ALARM_COUNT=$(aws cloudwatch describe-alarms --alarm-names ${onlineEvalAlarmName} --alarm-types CompositeAlarm --query 'length(CompositeAlarms)' --output text)`,
        `if [ "$ALARM_COUNT" != "1" ]; then echo "ERROR: composite alarm ${onlineEvalAlarmName} not found (describe-alarms returned '$ALARM_COUNT'); soak FAILED"; exit 1; fi`,
        `SOAK_POLLS=$((${canarySoakMinutes} * 2))`,
        "POLL=0",
        'while [ "$POLL" -lt "$SOAK_POLLS" ]; do',
        `  STATE=$(${describeAlarmState})`,
        '  case "$STATE" in',
        '    ALARM) echo "ERROR: canary regressed (alarm state ALARM); soak FAILED"; exit 1 ;;',
        "    OK|INSUFFICIENT_DATA) ;;",
        "    *) echo \"ERROR: unusable alarm state '$STATE'; soak FAILED\"; exit 1 ;;",
        "  esac",
        "  POLL=$((POLL + 1))",
        "  sleep 30",
        "done",
        `FINAL_STATE=$(${describeAlarmState})`,
        `if [ "$FINAL_STATE" != "OK" ]; then echo "ERROR: soak ended with alarm state '$FINAL_STATE'; OK required; soak FAILED"; exit 1; fi`,
        'echo "Canary soak passed"',
      ],
      buildEnvironment: { buildImage: LinuxBuildImage.STANDARD_7_0 },
      timeout: Duration.minutes(canarySoakMinutes + 5),
    });

    const prodStage = new WorkloadDeploymentStage(this, "Prod", {
      env: props.workloadProdEnv,
      envName: "prod",
      tenantId: props.tenantId,
      agentId: props.agentId,
      applicationId,
      costCentre: props.costCentre,
      availabilityZones: props.workloadProdAvailabilityZones,
      gaRegistryContext: props.gaRegistry?.prod,
      gatewayRegion: props.gaRegistry?.gatewayRegion,
      policyEngineMode: props.policyEngine?.mode,
      policyEngineIamRoleArns: props.policyEngine?.prodIamRoleArns,
      enablePipelineRuntimeMemory: props.enablePipelineRuntimeMemory,
      agentImageVariant: props.agentImageVariant,
      generatedAgentInference: props.generatedAgentInference?.prod,
      auditOamSinkArn: props.auditOamSinkArn,
      notificationEmail: props.notificationEmail,
      benefitsQaImageUri: props.benefitsQaImageUri,
      benefitsQaJwtAuthorizer: props.benefitsQaJwtAuthorizer,
      inferenceM2mSecretArn: props.inferenceM2mSecretArn,
      inferenceGatewayUrl: props.inferenceGatewayUrl,
      inferenceModelId: props.inferenceModelId,
    });

    if (props.gaRegistry) {
      const gaApproval = new ManualApprovalStep("ProdGatewayApproval", {
        comment: props.policyEngine
          ? `Approve only after nonproduction Registry/MCP denial twins and PolicyEngine ${props.policyEngine.mode} behavior match the retained Lambda wrapper. Production must not lead nonproduction mode evidence.`
          : evaluationEnabled
            ? "The generated-agent evaluation gate passed through the nonproduction Runtime. Approve only after its Registry, MCP, guardrail, Memory, and denial evidence is attached."
            : props.enablePipelineRuntimeMemory
              ? "Approve only after nonproduction Gateway targets pass live Registry, tools/list, tools/call, and denial twins, and the native Runtime+Memory compatibility foundation reached Runtime READY / Memory ACTIVE."
              : "Approve only after nonproduction Gateway targets pass live Registry, tools/list, tools/call, and denial twins. No agent runtime/canary exists in the R2 Gateway-only slice.",
      });
      if (evaluationEnabled) {
        gaApproval.addStepDependency(evalStep);
      }
      this.pipeline.addStage(prodStage, {
        pre: evaluationEnabled ? [evalStep, gaApproval] : [gaApproval],
      });
    } else {
      const approvalStep = new ManualApprovalStep("ProdApproval", {
        comment:
          "Evaluation gate passed. Approving starts the canary deploy and soak; Prod deploys only if the soak passes.",
      });
      approvalStep.addStepDependency(evalStep);
      canaryDeployStep.addStepDependency(approvalStep);
      canarySoakStep.addStepDependency(canaryDeployStep);

      this.pipeline.addStage(prodStage, {
        pre: [evalStep, approvalStep, canaryDeployStep, canarySoakStep],
      });
    }

    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: "AwsSolutions-CB4",
          reason:
            "SEC-017: CodeBuild artifacts flow through the explicit customer-managed, rotating pipeline artifact CMK.",
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "SEC-011: Pipeline roles require wildcards for CDK bootstrap.",
        },
        {
          id: "AwsSolutions-S1",
          reason:
            "SEC-001: Pipeline artifacts expire after 30 days; CodePipeline execution history and CloudTrail provide the audit trail without a recursive access-log bucket.",
        },
        {
          id: "AwsSolutions-L1",
          reason: "SEC-006: CDK Pipelines-generated Lambdas track aws-cdk-lib.",
        },
        {
          id: "NIST.800.53.R5-CodeBuildProjectEnvVarAwsCred",
          reason:
            "SEC-018: CodeBuild reads bootstrap role creds via STS, not env vars.",
        },
        {
          id: "NIST.800.53.R5-CodeBuildProjectKMSEncryptedArtifacts",
          reason:
            "SEC-017: The explicit pipeline artifact bucket uses a customer-managed rotating KMS key shared with cross-account stages.",
        },
        {
          id: "NIST.800.53.R5-CodeBuildProjectPrivilegedModeDisabled",
          reason:
            "SEC-019: Synth/build run in standard non-privileged containers.",
        },
        {
          id: "NIST.800.53.R5-CodeBuildProjectSourceRepoUrl",
          reason:
            "SEC-020: Source comes from a versioned S3 object uploaded by the LOB CI job on trunk merge.",
        },
        {
          id: "NIST.800.53.R5-IAMNoInlinePolicy",
          reason: "SEC-005: CDK Pipelines auto-generates inline policies.",
        },
        {
          id: "NIST.800.53.R5-S3BucketLoggingEnabled",
          reason:
            "SEC-001: The short-lived artifact bucket uses a 30-day lifecycle; pipeline execution history and CloudTrail retain access evidence.",
        },
        {
          id: "NIST.800.53.R5-S3BucketReplicationEnabled",
          reason: "SEC-002: CRR deferred to v2 DR roadmap.",
        },
        {
          id: "NIST.800.53.R5-S3DefaultEncryptionKMS",
          reason:
            "SEC-003: The artifact bucket uses an explicit customer-managed rotating KMS key.",
        },
        {
          id: "NIST.800.53.R5-LambdaConcurrency",
          reason:
            "SEC-007: Self-mutate and artifact-cleanup Lambdas are provisioning-time only.",
        },
        {
          id: "NIST.800.53.R5-LambdaDLQ",
          reason:
            "SEC-008: CFN custom-resource Lambdas surface failures via stack events.",
        },
        {
          id: "NIST.800.53.R5-LambdaInsideVPC",
          reason:
            "SEC-009: Pipeline Lambdas call AWS control planes via managed endpoints.",
        },
        {
          id: "NIST.800.53.R5-S3BucketVersioningEnabled",
          reason:
            "SEC-022: Pipeline artifacts are immutable per execution, expire after 30 days, and are automatically removed with the stack.",
        },
      ],
      true,
    );
  }

  private synthContext(
    props: S3WorkloadPipelineStackProps,
  ): Record<string, string> {
    const applicationId = props.applicationId ?? props.tenantId;
    const derived: Record<string, string> = {
      "agenticai/pipelineSelection": "workload",
      "agenticai/tenantId": props.tenantId,
      "agenticai/agentId": props.agentId,
      "agenticai/costCentre": props.costCentre,
      "agenticai/workloadNonprodAccountId": props.workloadNonprodEnv.account,
      "agenticai/workloadProdAccountId": props.workloadProdEnv.account,
      "agenticai/workloadNonprodAvailabilityZones": JSON.stringify(
        props.workloadNonprodAvailabilityZones,
      ),
      "agenticai/workloadProdAvailabilityZones": JSON.stringify(
        props.workloadProdAvailabilityZones,
      ),
      "agenticai/applicationId": applicationId,
    };
    if (props.auditOamSinkArn) {
      derived["agenticai/auditOamSinkArn"] = props.auditOamSinkArn;
    }
    if (props.notificationEmail) {
      derived["agenticai/notificationEmail"] = props.notificationEmail;
    }
    if (props.gaRegistry) {
      derived["agenticai/enableGaRegistryConsumer"] = "true";
      derived["agenticai/platformNonprodAccountId"] =
        props.gaRegistry.nonprod.platformAccountId;
      derived["agenticai/platformProdAccountId"] =
        props.gaRegistry.prod.platformAccountId;
      derived["agenticai/gaRegistryExpectedToolIds"] = JSON.stringify(
        props.gaRegistry.nonprod.records.map((r) => r.document.toolId),
      );
      derived["agenticai/workstreamGatewayRegion"] =
        props.gaRegistry.gatewayRegion;
    }
    if (props.policyEngine) {
      derived["agenticai/gatewayPolicyEngineMode"] = props.policyEngine.mode;
      derived["agenticai/gatewayPolicyEngineNonprodIamRoleArns"] =
        JSON.stringify(props.policyEngine.nonprodIamRoleArns);
      derived["agenticai/gatewayPolicyEngineProdIamRoleArns"] = JSON.stringify(
        props.policyEngine.prodIamRoleArns,
      );
    }
    if (props.enablePipelineRuntimeMemory) {
      derived["agenticai/enablePipelineRuntimeMemory"] = "true";
    }
    if (props.agentImageVariant === "generated-agent") {
      derived["agenticai/agentImageVariant"] = "generated-agent";
      if (!props.generatedAgentInference) {
        throw new Error(
          "S3WorkloadPipelineStack: generatedAgentInference is required when agentImageVariant is 'generated-agent'.",
        );
      }
      derived["agenticai/generatedAgentInference"] = JSON.stringify(
        props.generatedAgentInference,
      );
    }
    return {
      ...derived,
      ...(props.synthContext ?? {}),
      "agenticai/pipelineSelection": "workload",
    };
  }

  private canaryDeployCommands(
    props: S3WorkloadPipelineStackProps,
    canaryPercent: number,
  ): string[] {
    if (props.canaryDeployCommands && props.canaryDeployCommands.length > 0) {
      return ["set -eu", ...props.canaryDeployCommands];
    }
    return [
      "set -eu",
      `echo "CanaryDeploy: NOT IMPLEMENTED — no AgentCore traffic-shifting call is wired for ${canaryPercent}% canary traffic."`,
      'echo "This step fails closed on purpose: promoting to Prod without a real canary would be an unverified claim."',
      'echo "Supply S3WorkloadPipelineStackProps.canaryDeployCommands with a real AgentCore traffic-shift call to enable it."',
      "exit 1",
    ];
  }
}
