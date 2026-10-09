/**
 * WorkloadAppStack — deployed alongside WorkloadNetworkStack.
 *
 * Composes the per-workload posture:
 *   - LiteLLM gateway (D-01)
 *   - AgentCore Gateway + API Gateway fronting (§08 Option A)
 *   - AgentCore Identity (Cognito + Token Vault CMK)
 *   - AgenticApp L3 per agent — Runtime + Memory + inference profile
 *   - Bedrock quota-increase requests
 *   - RAG knowledge base per tenant
 *
 * Requires WorkloadNetworkStack to have landed first (VPC + VPCEs + invocation logging).
 *
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */
import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { IVpc, Vpc } from 'aws-cdk-lib/aws-ec2';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

import { UserPool } from 'aws-cdk-lib/aws-cognito';
import { AgentCoreGatewayConstruct, ApiGatewayFronting } from '@agenticai/agentcore-gateway';
import { AgentCoreIdentityConstruct } from '@agenticai/agentcore-identity';
import { AgenticApp } from '@agenticai/agentic-app';
import { AgentCoreRuntimeProvisioner } from '@agenticai/agentcore-runtime';
import type { AgentCoreRuntimeJwtAuthorizerProps } from '@agenticai/agentcore-runtime';
import { RagKnowledgeBaseConstruct } from '@agenticai/rag';
import {
  OamSourceLinkConstruct,
  AgenticDashboardConstruct,
  AgenticAlarmsConstruct,
} from '@agenticai/observability';
import { AgenticAppBudgetConstruct } from '@agenticai/cost-allocation';

export interface WorkloadAppStackProps extends StackProps {
  /**
   * VPC ID produced by WorkloadNetworkStack. Resolved via CloudFormation
   * import-value; when the two stacks deploy together the import is implicit.
   */
  readonly vpcId: string;
  /**
   * Subnet ids — at least the 'workload' private subnets.
   */
  readonly workloadSubnetIds: readonly string[];
  /** Route-table IDs in the same order as `workloadSubnetIds`. */
  readonly workloadSubnetRouteTableIds: readonly string[];
  readonly vpcCidr: string;
  /**
   * Availability zones covered by the VPC. Must match the source stack
   * (3 AZs per Phase 4 default).
   */
  readonly availabilityZones: readonly string[];
  /**
   * The Bedrock Runtime VPCE id in the same VPC — used to restrict RAG
   * bucket access to in-VPC callers only.
   */
  readonly bedrockRuntimeVpceId: string;
  readonly envName: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly costCentre: string;

  /**
   * External Cognito User Pool to use for API Gateway JWT auth instead of
   * creating a new pool. Pass the Pool ID of an existing pool (e.g. loom-user-pool
   * in the platform account). The pool can be cross-account — API Gateway resolves
   * the issuer URL from the public JWKS endpoint.
   */
  readonly externalUserPoolId?: string;
  /** User Pool Client ID on the external pool to use as the JWT audience. */
  readonly externalUserPoolClientId?: string;
  /** AWS region of the external user pool. Defaults to stack region. */
  readonly externalUserPoolRegion?: string;

  /** Audit-account OAM sink ARN (imported from AuditStack). */
  readonly auditOamSinkArn?: string;

  /** Monthly budget alert threshold, USD. Default 500. */
  readonly monthlyBudgetUsd?: number;

  /** Operator notification address for budget alerts. */
  readonly notificationEmail?: string;

  /**
   * ECR image URI (with digest) for the benefits-qa agent container.
   * When supplied, the stack calls CreateAgentRuntime via AwsCustomResource
   * so the runtime slot is tracked in CloudFormation.
   * Example: `123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag@sha256:…`
   */
  readonly benefitsQaImageUri?: string;
  /** Guardrail ID to inject into the benefits-qa runtime container. */
  readonly benefitsQaGuardrailId?: string;
  /**
   * JWT authorizer for the benefits-qa runtime. When supplied, callers may
   * authenticate with a Cognito Bearer token in addition to IAM/SigV4.
   * Typically points at the loom-user-pool (cross-account).
   */
  readonly benefitsQaJwtAuthorizer?: AgentCoreRuntimeJwtAuthorizerProps;
}

export class WorkloadAppStack extends Stack {
  readonly vpc: IVpc;
  readonly identity: AgentCoreIdentityConstruct;
  readonly gateway: AgentCoreGatewayConstruct;
  readonly apiGatewayFront: ApiGatewayFronting;
  readonly app: AgenticApp;
  readonly rag: RagKnowledgeBaseConstruct;
  readonly benefitsQaRuntime?: AgentCoreRuntimeProvisioner;

  constructor(scope: Construct, id: string, props: WorkloadAppStackProps) {
    super(scope, id, props);

    // Import the VPC produced by WorkloadNetworkStack.
    this.vpc = Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId: props.vpcId,
      availabilityZones: [...props.availabilityZones],
      isolatedSubnetIds: [...props.workloadSubnetIds],
      isolatedSubnetRouteTableIds: [...props.workloadSubnetRouteTableIds],
      vpcCidrBlock: props.vpcCidr,
    });

    // ---- AgentCore Identity (Token Vault CMK; Cognito pool may be external) ----
    this.identity = new AgentCoreIdentityConstruct(this, 'Identity', {
      envName: props.envName,
    });

    // ---- AgentCore Gateway (Tool Gateway per §08 / §2.3) ----
    this.gateway = new AgentCoreGatewayConstruct(this, 'AgentCoreGateway', {
      vpc: this.vpc,
      envName: props.envName,
    });

    // ---- API Gateway fronting (primary client auth boundary) ----
    // Use the external loom-user-pool (cross-account) when supplied so the
    // frontend app's existing Cognito tokens are accepted without re-auth.
    // Fall back to the locally-created pool for standalone deployments.
    const userPoolRegion = props.externalUserPoolRegion ?? this.region;
    const frontingUserPool = props.externalUserPoolId
      ? UserPool.fromUserPoolId(this, 'ExternalUserPool', props.externalUserPoolId)
      : this.identity.userPool;
    const frontingClientId = props.externalUserPoolClientId
      ?? this.identity.userPoolClient.userPoolClientId;
    this.apiGatewayFront = new ApiGatewayFronting(this, 'ApiGwFront', {
      vpc: this.vpc,
      userPool: frontingUserPool,
      userPoolRegion,
      userPoolClientId: frontingClientId,
      targetAlbListenerArn: this.gateway.albListener.listenerArn,
      targetAlbSecurityGroup: this.gateway.albSg,
    });

    // ---- AgenticApp L3 per tenant/agent ----
    this.app = new AgenticApp(this, 'App', {
      vpc: this.vpc,
      tenantId: props.tenantId,
      agentId: props.agentId,
      envName: props.envName,
      costCentre: props.costCentre,
    });

    // ---- Benefits Q&A Runtime (CDK-managed via AwsCustomResource) ----
    // Provisioned only when an image URI is supplied (e.g. after a container
    // build + push step). The runtime ID is emitted as a stack output so the
    // platform team can reference it when adding the registry record.
    if (props.benefitsQaImageUri) {
      // The exec role already has write access to this.app.runtime.logGroup (granted in AgentCoreRuntimeConstruct).
      // OTEL is configured to write to that same workload-account log group; OAM then surfaces it centrally.
      const logGroupName = this.app.runtime.logGroup.logGroupName;

      this.benefitsQaRuntime = new AgentCoreRuntimeProvisioner(this, 'BenefitsQaRuntime', {
        runtimeConstruct: this.app.runtime,
        containerImageUri: props.benefitsQaImageUri,
        agentRuntimeName: `benefitsQa${props.envName}`,
        description: 'PPO Benefits Q&A agent for member service representatives',
        networkMode: 'PUBLIC',
        jwtAuthorizer: props.benefitsQaJwtAuthorizer,
        environmentVariables: {
          INFERENCE_PROFILE_ARN: this.app.inferenceProfile.attrInferenceProfileArn,
          GUARDRAIL_IDENTIFIER: props.benefitsQaGuardrailId ?? '',
          GUARDRAIL_VERSION: 'DRAFT',
          PLAN_YEAR: '2026',
          ENV_NAME: props.envName,
          AGENT_OBSERVABILITY_ENABLED: 'true',
          OTEL_PYTHON_DISTRO: 'aws_distro',
          OTEL_PYTHON_CONFIGURATOR: 'aws_configurator',
          OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
          OTEL_EXPORTER_OTLP_LOGS_HEADERS: `x-aws-log-group=${logGroupName},x-aws-log-stream=benefits-qa,x-aws-metric-namespace=agenticai/runtimes`,
          OTEL_RESOURCE_ATTRIBUTES: `service.name=benefits-qa-${props.envName}`,
        },
      });
    }

    // ---- RAG knowledge base (VPCE-only) ----
    this.rag = new RagKnowledgeBaseConstruct(this, 'RagKb', {
      tenantId: props.tenantId,
      kbId: 'primary',
      envName: props.envName,
      approvedVpceId: props.bedrockRuntimeVpceId,
    });

    // ---- Phase 6 — Observability + cost ----
    if (props.auditOamSinkArn) {
      new OamSourceLinkConstruct(this, 'OamSourceLink', {
        sinkArn: props.auditOamSinkArn,
      });
    }

    new AgenticDashboardConstruct(this, 'Dashboard', {
      envName: props.envName,
      tenantId: props.tenantId,
      agentId: props.agentId,
      inferenceProfileName: `agenticai-${props.envName}-${props.tenantId}-${props.agentId}`,
    });

    new AgenticAlarmsConstruct(this, 'Alarms', {
      envName: props.envName,
      tenantId: props.tenantId,
      agentId: props.agentId,
      inferenceProfileName: `agenticai-${props.envName}-${props.tenantId}-${props.agentId}`,
    });

    if (props.notificationEmail) {
      new AgenticAppBudgetConstruct(this, 'Budget', {
        tenantId: props.tenantId,
        envName: props.envName,
        monthlyBudgetUsd: props.monthlyBudgetUsd ?? 500,
        notificationEmail: props.notificationEmail,
      });
    }

    // Stack-level cdk-nag suppressions for CDK-generated custom-resource/
    // Lambda helpers and VPC-import noise that can't be authored otherwise.
    NagSuppressions.addStackSuppressions(
      this,
      [
        { id: 'AwsSolutions-L1', reason: 'SEC-006: CDK-managed custom-resource Lambda runtime; tracks aws-cdk-lib.' },
        { id: 'AwsSolutions-IAM4', reason: 'SEC-010: AWSLambdaBasicExecutionRole is the documented CDK custom-resource role.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
        { id: 'NIST.800.53.R5-LambdaConcurrency', reason: 'SEC-007: Provisioning-time only.' },
        { id: 'NIST.800.53.R5-LambdaDLQ', reason: 'SEC-008: CloudFormation surfaces failures.' },
        { id: 'NIST.800.53.R5-LambdaInsideVPC', reason: 'SEC-009: Control-plane calls to AWS-managed endpoints.' },
        { id: 'NIST.800.53.R5-IAMNoInlinePolicy', reason: 'SEC-005: CDK-generated roles use inline policies.' },
        { id: 'AwsSolutions-IAM5', reason: 'SEC-011: Custom-resource account-level APIs have no resource ARN.' },
      ],
      true,
    );

    // ---- Outputs ----
    new CfnOutput(this, 'ApiGatewayUrl', {
      value: `https://${this.apiGatewayFront.api.attrApiEndpoint}`,
      description: 'Primary auth boundary for agent traffic.',
    });
    new CfnOutput(this, 'UserPoolId', { value: this.identity.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.identity.userPoolClient.userPoolClientId });
    new CfnOutput(this, 'InferenceProfileArn', { value: this.app.inferenceProfile.attrInferenceProfileArn });
    new CfnOutput(this, 'RagBucketName', { value: this.rag.sourceBucket.bucketName });
    if (this.benefitsQaRuntime) {
      new CfnOutput(this, 'BenefitsQaRuntimeId', {
        value: this.benefitsQaRuntime.agentRuntimeId,
        description: 'AgentCore Runtime ID for the benefits-qa agent — needed for the registry record.',
      });
    }
  }
}
