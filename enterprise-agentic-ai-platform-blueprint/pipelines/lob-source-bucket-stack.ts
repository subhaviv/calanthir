// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// LobSourceBucket — the per-TENANT pipeline source bucket, created ONCE at
// LOB-onboard (level 2). Every agent in the tenant uploads to its OWN prefix
// in this one bucket (`<agentId>/workload-source.zip`), and each agent's
// S3WorkloadPipelineStack is passed this bucket as `sourceBucket` + its own
// `sourceObjectKey`. This makes the bucket genuinely tenant-owned (not created
// as a side effect of the first agent's pipeline) and agent-onboard just writes
// a folder.
//
// Deploy once per tenant (platform account), e.g.:
//   new LobSourceBucket(app, "aifactory-<tenant>-LobSourceBucket", {
//     env: { account: "195698601974", region: "us-east-1" },
//     tenantId: "<tenant>",
//     ciRunnerArn: "arn:aws:iam::<workload-acct>:user/agenticai-ci-runner-<tenant>",
//   });
import { Stack, StackProps, RemovalPolicy, CfnOutput } from "aws-cdk-lib";
import { Bucket, BucketEncryption, BlockPublicAccess } from "aws-cdk-lib/aws-s3";
import { ArnPrincipal, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

export interface LobSourceBucketProps extends StackProps {
  readonly tenantId: string;
  /**
   * The LOB CI principal allowed to upload source zips. In the access-key model
   * this is an IAM USER ARN (`.../user/agenticai-ci-runner-<tenant>`); a role ARN
   * also works if the tenant uses assume-role. Granted PutObject on ALL prefixes
   * so each agent can write its own `<agentId>/workload-source.zip`.
   */
  readonly ciRunnerArn: string;
}

export class LobSourceBucket extends Stack {
  readonly bucketName: string;

  constructor(scope: Construct, id: string, props: LobSourceBucketProps) {
    super(scope, id, props);

    const bucket = new Bucket(this, "SourceBucket", {
      bucketName: `agenticai-pipeline-source-${props.tenantId}`,
      versioned: true, // required by CodePipelineSource.s3()
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // The tenant's one CI principal uploads every agent's source under its own
    // prefix. PutObject on bucket/* covers all `<agentId>/...` keys.
    bucket.addToResourcePolicy(new PolicyStatement({
      principals: [new ArnPrincipal(props.ciRunnerArn)],
      actions: ["s3:PutObject", "s3:GetBucketVersioning"],
      resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
    }));

    this.bucketName = bucket.bucketName;
    new CfnOutput(this, "SourceBucketName", { value: bucket.bucketName });

    // This is a versioned, SSE-encrypted, BLOCK_ALL CI source bucket holding
    // short-lived workload-source zips; CodePipeline execution history + CloudTrail
    // are the audit trail, matching S3WorkloadPipelineStack's own suppressions.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: "AwsSolutions-S1",
        reason: "SEC-001: CI source bucket holds transient workload zips; CloudTrail + CodePipeline history provide the audit trail without a recursive access-log bucket.",
      },
      {
        id: "NIST.800.53.R5-S3BucketLoggingEnabled",
        reason: "SEC-001: Same as AwsSolutions-S1 — transient CI source, audited via CloudTrail/CodePipeline.",
      },
      {
        id: "NIST.800.53.R5-S3BucketReplicationEnabled",
        reason: "SEC-002: Source zips are reproducible from the LOB repo on re-merge; cross-region replication is unnecessary for a rebuildable CI artifact.",
      },
      {
        id: "NIST.800.53.R5-S3DefaultEncryptionKMS",
        reason: "SEC-003: S3-managed (SSE-S3) encryption is sufficient for non-PHI, rebuildable build-source zips; matches the pipeline stack's source bucket.",
      },
    ]);
  }
}
