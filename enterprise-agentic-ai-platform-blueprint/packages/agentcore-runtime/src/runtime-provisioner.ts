/**
 * AgentCoreRuntimeProvisioner — CDK-managed CreateAgentRuntime via AwsCustomResource.
 *
 * Sits alongside AgentCoreRuntimeConstruct and calls the
 * bedrock-agentcore-control::CreateAgentRuntime API at deploy time so the
 * runtime slot is tracked in CloudFormation rather than created by an
 * imperative CLI call. The physical resource ID is the agentRuntimeId
 * returned by the API.
 *
 * On stack deletion the custom resource calls DeleteAgentRuntime.
 *
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */
import { Stack } from 'aws-cdk-lib';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
  PhysicalResourceIdReference,
} from 'aws-cdk-lib/custom-resources';
import { PolicyStatement, Effect, Role } from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

import { AgentCoreRuntimeConstruct } from './runtime-construct';

export interface AgentCoreRuntimeJwtAuthorizerProps {
  /**
   * Cognito issuer URL — `https://cognito-idp.<region>.amazonaws.com/<poolId>`.
   * Can be cross-account: AgentCore fetches the public JWKS endpoint.
   */
  readonly issuerUrl: string;
  /** Audience values the token must contain (Cognito app-client IDs). */
  readonly allowedClients: readonly string[];
}

export interface AgentCoreRuntimeProvisionerProps {
  /** The sibling construct that holds the execution role and ECR repo. */
  readonly runtimeConstruct: AgentCoreRuntimeConstruct;
  /**
   * Fully-qualified ECR image URI including digest, e.g.:
   * `123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag@sha256:abc…`
   * Using a digest (not just a tag) ensures immutable deployments.
   */
  readonly containerImageUri: string;
  /** Human-readable description stored in the runtime registration. */
  readonly description: string;
  /**
   * Environment variables injected into the container at runtime.
   * Never put secrets here — use Secrets Manager and mount via the
   * execution role.
   */
  readonly environmentVariables?: Record<string, string>;
  /**
   * Network mode. PUBLIC is required until AgentCore VPC mode is GA for the
   * target region. Defaults to PUBLIC.
   */
  readonly networkMode?: 'PUBLIC' | 'VPC';
  /** Agent runtime name — must match [a-zA-Z][a-zA-Z0-9_]{0,47}. */
  readonly agentRuntimeName: string;
  /**
   * Optional JWT authorizer. When supplied, callers may authenticate with a
   * Cognito access token (Bearer) in addition to IAM/SigV4. The runtime
   * accepts both paths simultaneously.
   */
  readonly jwtAuthorizer?: AgentCoreRuntimeJwtAuthorizerProps;
}

export class AgentCoreRuntimeProvisioner extends Construct {
  /** The agentRuntimeId returned by CreateAgentRuntime. */
  readonly agentRuntimeId: string;
  /** The agentRuntimeArn returned by CreateAgentRuntime. */
  readonly agentRuntimeArn: string;

  constructor(
    scope: Construct,
    id: string,
    props: AgentCoreRuntimeProvisionerProps,
  ) {
    super(scope, id);

    const stack = Stack.of(this);
    const rc = props.runtimeConstruct;
    const networkMode = props.networkMode ?? 'PUBLIC';

    // The custom resource Lambda needs permission to call the AgentCore
    // control-plane APIs and to pass the execution role.
    const crPolicy = AwsCustomResourcePolicy.fromStatements([
      new PolicyStatement({
        sid: 'AgentCoreControlPlane',
        effect: Effect.ALLOW,
        // bedrock-agentcore:CreateAgentRuntime triggers several implicit dependent
        // actions (CreateAgentRuntimeEndpoint, CreateWorkloadIdentity, etc.) that
        // are not documented as separate grant requirements but appear in IAM
        // checks at runtime. Use a wildcard here; scope is still the control-plane
        // service only and the Nag suppression (SEC-040) covers this.
        actions: ['bedrock-agentcore:*'],
        resources: ['*'],
      }),
      new PolicyStatement({
        sid: 'PassExecutionRole',
        effect: Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [rc.executionRole.roleArn],
      }),
    ]);

    const authorizerConfig = props.jwtAuthorizer
      ? {
          customJWTAuthorizer: {
            discoveryUrl: props.jwtAuthorizer.issuerUrl,
            allowedClients: props.jwtAuthorizer.allowedClients,
          },
        }
      : undefined;

    const runtimeParams = {
      agentRuntimeName: props.agentRuntimeName,
      description: props.description,
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: props.containerImageUri,
        },
      },
      networkConfiguration: { networkMode },
      roleArn: rc.executionRole.roleArn,
      ...(props.environmentVariables && {
        environmentVariables: props.environmentVariables,
      }),
      ...(authorizerConfig && { authorizerConfiguration: authorizerConfig }),
    };

    const cr = new AwsCustomResource(this, 'RuntimeCr', {
      resourceType: 'Custom::AgentCoreRuntime',
      installLatestAwsSdk: false,
      policy: crPolicy,
      onCreate: {
        service: 'bedrock-agentcore-control',
        action: 'CreateAgentRuntime',
        parameters: runtimeParams,
        physicalResourceId: PhysicalResourceId.fromResponse('agentRuntimeId'),
      },
      onUpdate: {
        service: 'bedrock-agentcore-control',
        action: 'UpdateAgentRuntime',
        parameters: {
          agentRuntimeId: new PhysicalResourceIdReference(),
          agentRuntimeArtifact: runtimeParams.agentRuntimeArtifact,
          networkConfiguration: runtimeParams.networkConfiguration,
          roleArn: runtimeParams.roleArn,
          ...(props.environmentVariables && {
            environmentVariables: props.environmentVariables,
          }),
          ...(authorizerConfig && { authorizerConfiguration: authorizerConfig }),
        },
        physicalResourceId: PhysicalResourceId.fromResponse('agentRuntimeId'),
      },
      onDelete: {
        service: 'bedrock-agentcore-control',
        action: 'DeleteAgentRuntime',
        parameters: {
          agentRuntimeId: new PhysicalResourceIdReference(),
        },
        ignoreErrorCodesMatching: 'ResourceNotFoundException',
      },
    });

    this.agentRuntimeId = cr.getResponseField('agentRuntimeId');
    this.agentRuntimeArn = `arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}:agent-runtime/${this.agentRuntimeId}`;

    NagSuppressions.addResourceSuppressions(
      cr,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'SEC-040: bedrock-agentcore-control CreateAgentRuntime/DeleteAgentRuntime have no resource-level ARN available at synth time (the runtime ID is service-generated). Scoped to control-plane actions only.',
        },
        {
          id: 'AwsSolutions-L1',
          reason:
            'SEC-006: AwsCustomResource uses the CDK-managed custom-resource Lambda; runtime version tracks aws-cdk-lib.',
        },
      ],
      true,
    );
  }
}
