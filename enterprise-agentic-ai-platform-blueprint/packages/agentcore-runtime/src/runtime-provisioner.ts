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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
} from 'aws-cdk-lib/custom-resources';
import { PolicyStatement, Effect, Role } from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

import { AgentCoreRuntimeConstruct } from './runtime-construct';

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
        actions: [
          'bedrock-agentcore-control:CreateAgentRuntime',
          'bedrock-agentcore-control:DeleteAgentRuntime',
          'bedrock-agentcore-control:GetAgentRuntime',
        ],
        resources: ['*'],
      }),
      new PolicyStatement({
        sid: 'PassExecutionRole',
        effect: Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [rc.executionRole.roleArn],
      }),
    ]);

    const cr = new AwsCustomResource(this, 'RuntimeCr', {
      resourceType: 'Custom::AgentCoreRuntime',
      installLatestAwsSdk: false,
      policy: crPolicy,
      onCreate: {
        service: 'bedrock-agentcore-control',
        action: 'CreateAgentRuntime',
        parameters: {
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
        },
        physicalResourceId: PhysicalResourceId.fromResponse('agentRuntimeId'),
      },
      onDelete: {
        service: 'bedrock-agentcore-control',
        action: 'DeleteAgentRuntime',
        parameters: {
          // Overridden at deploy time via addPropertyOverride below to use the
          // physical resource ID (agentRuntimeId) captured during onCreate.
          agentRuntimeId: 'PLACEHOLDER',
        },
        ignoreErrorCodesMatching: 'ResourceNotFoundException',
      },
    });

    // Patch the delete parameter to reference the physical ID token so CDK
    // resolves the actual runtime ID at delete time.
    const crCfn = cr.node.defaultChild as any;
    if (crCfn) {
      crCfn.addPropertyOverride(
        'Delete.parameters.agentRuntimeId',
        cr.getResponseField('agentRuntimeId'),
      );
    }

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
