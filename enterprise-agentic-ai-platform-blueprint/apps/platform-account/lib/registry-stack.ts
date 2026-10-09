/**
 * RegistryStack — deployed to agenticai-platform-{nonprod,prod}.
 *
 * The existing DynamoDB registry remains unchanged as the rollback path while
 * the native GA Agent Registry is introduced blue-green alongside it.
 *
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */
import { CfnOutput, CfnResource, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";

import {
  GaPlatformRegistryConstruct,
  GaPlatformToolsConstruct,
} from "@agenticai/agent-registry";
import { AgentCoreRegistryConstruct } from "@agenticai/agentcore-registry";

export interface RegistryStackProps extends StackProps {
  readonly envName: "nonprod" | "prod";
  readonly workloadAccountIds: readonly string[];
  readonly registrySynthAccountId: string;
  readonly grantGatewayInvokePermissions?: boolean;
  readonly gatewayServiceRoleArns?: readonly string[];
  readonly gatewayWorkloadAccountId?: string;
  readonly gaRegistryRecordGenerations?: Readonly<Record<string, number>>;
  readonly applicationId: string;
  readonly agentId: string;
  readonly tenantId: string;
  readonly costCentre: string;

  /**
   * HTTPS endpoint of the workload API Gateway fronting the benefits-qa
   * Runtime. When supplied a DRAFT RegistryRecord is created in the GA
   * registry so the platform curator can review and approve it.
   *
   * Example: `https://eoku9zqkg4.execute-api.us-east-1.amazonaws.com`
   *
   * Omit until the workload stack has been deployed and the endpoint is known.
   */
  readonly benefitsQaA2aEndpointUrl?: string;
}

export class RegistryStack extends Stack {
  /** Existing DynamoDB placeholder retained unchanged during migration. */
  readonly registry: AgentCoreRegistryConstruct;
  /** Pipeline-owned, environment-isolated Lambda tool aliases. */
  readonly gaTools: GaPlatformToolsConstruct;
  /** Native GA producer consumed by opt-in R2 Workstream pipelines. */
  readonly gaRegistry: GaPlatformRegistryConstruct;

  constructor(scope: Construct, id: string, props: RegistryStackProps) {
    super(scope, id, props);
    this.registry = new AgentCoreRegistryConstruct(this, "Registry", {
      envName: props.envName,
    });
    new CfnOutput(this, "AgentTableName", {
      value: this.registry.agentTable.tableName,
    });
    new CfnOutput(this, "ToolTableName", {
      value: this.registry.toolTable.tableName,
    });

    this.gaTools = new GaPlatformToolsConstruct(this, "GaTools", {
      envName: props.envName,
      workloadAccountIds: props.workloadAccountIds,
      applicationId: props.applicationId,
      agentId: props.agentId,
      tenantId: props.tenantId,
      costCentre: props.costCentre,
      grantGatewayInvokePermissions: props.grantGatewayInvokePermissions,
      gatewayServiceRoleArns: props.gatewayServiceRoleArns,
      gatewayWorkloadAccountId: props.gatewayWorkloadAccountId,
    });

    this.gaRegistry = new GaPlatformRegistryConstruct(this, "GaRegistry", {
      envName: props.envName,
      workloadAccountIds: props.workloadAccountIds,
      registrySynthAccountId: props.registrySynthAccountId,
      toolTargetArns: this.gaTools.aliasArns,
      recordGenerations: props.gaRegistryRecordGenerations,
      tags: {
        applicationId: props.applicationId,
        agentId: props.agentId,
        tenantId: props.tenantId,
        costCentre: props.costCentre,
        environment: props.envName,
      },
    });
    for (const [toolId, record] of Object.entries(this.gaRegistry.records)) {
      record.addDependsOn(
        this.gaTools.aliases[toolId].node.defaultChild as CfnResource,
      );
    }

    // ── Benefits Q&A agent record ──────────────────────────────────────────
    // Added by PR from the member-services team. Deployed by the platform
    // pipeline after PR review. Auto-approves in nonprod (APPROVE_ALL on the
    // registry). In prod, a curator must approve before the record becomes
    // discoverable.
    //
    // Pass the two context keys once the workload stack outputs are known:
    //   agenticai/benefitsQaA2aEndpointUrl  — API Gateway URL (public invocation endpoint)
    //   agenticai/benefitsQaRuntimeArn      — AgentCore Runtime ARN (from BenefitsQaRuntimeId output)
    if (props.benefitsQaA2aEndpointUrl) {
      const runtimeArn =
        typeof this.node.tryGetContext("agenticai/benefitsQaRuntimeArn") === "string"
          ? String(this.node.tryGetContext("agenticai/benefitsQaRuntimeArn"))
          : `arn:aws:bedrock-agentcore:${this.region}:${props.workloadAccountIds[0]}:agent-runtime/benefits-qa-pending`;

      const benefitsQaGovernance = {
        schemaVersion: "agenticai.tool-governance/1.0",
        catalogueVersion: "1",
        toolId: "benefits-qa-agent",
        description:
          "PPO Benefits Q&A agent for member service representatives. " +
          "Answers deductible, copay, OOP max, formulary, and network questions. " +
          "Escalates coverage determinations and prior-auth decisions to a licensed reviewer.",
        desiredApprovalStatus: "approved",
        target: {
          type: "agent-a2a",
          arn: runtimeArn,
        },
        mcp: {
          toolName: "benefits-qa-agent",
          description: "Query PPO plan benefits for member service representatives.",
          inputSchema: {
            type: "object",
            properties: {
              messages: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    role: { type: "string", enum: ["user", "assistant"] },
                    content: { type: "string" },
                  },
                  required: ["role", "content"],
                },
                description: "Conversation history for this session.",
              },
              actorId: {
                type: "string",
                description: "MSR employee ID or SSO subject — required for audit.",
              },
            },
            required: ["messages", "actorId"],
          },
        },
        authorization: {
          defaultDecision: "DENY",
          cedarPolicy:
            'permit(principal in AgenticAI::Group::"member-services-reps", action, resource);',
          allowedSubjects: [],
          allowedGroups: ["member-services-reps"],
          combination: "GROUP_ONLY",
        },
        ownership: {
          ownerTeam: "member-services",
          costCentre: props.costCentre,
        },
      };

      const benefitsQaRecord = new CfnResource(this, "BenefitsQaAgentRecord", {
        type: "AWS::AgentRegistry::RegistryRecord",
        properties: {
          RegistryId: this.gaRegistry.registryId,
          Name: "benefits-qa-agent",
          DisplayName: "Benefits Q&A Agent",
          Description: benefitsQaGovernance.description,
          RecordType: "CUSTOM",
          RecordVersion: "1.0.0",
          Descriptors: {
            Custom: { Data: JSON.stringify(benefitsQaGovernance) },
          },
          Tags: [
            { Key: "application-id", Value: props.applicationId },
            { Key: "agent-id", Value: "benefits-qa" },
            { Key: "tenant-id", Value: props.tenantId },
            { Key: "cost-centre", Value: props.costCentre },
            { Key: "environment", Value: props.envName },
            { Key: "owner-team", Value: "member-services" },
          ],
        },
      });
      benefitsQaRecord.addDependsOn(this.gaRegistry.registry);
      benefitsQaRecord.applyRemovalPolicy(RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE);

      new CfnOutput(this, "BenefitsQaRecordId", {
        value: benefitsQaRecord.getAtt("RecordId").toString(),
        description: "GA Registry record ID for the benefits-qa agent.",
      });
    }
  }
}
