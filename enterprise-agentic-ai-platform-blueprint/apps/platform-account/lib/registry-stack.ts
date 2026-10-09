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

      const agentDescription =
        "PPO Benefits Q&A agent for member service representatives. " +
        "Answers deductible, copay, OOP max, formulary, and network questions. " +
        "Escalates coverage determinations and prior-auth decisions to a licensed reviewer.";

      // A2A agent card — RecordType AGENT, Descriptors.A2aAgentCard shape.
      // dataSchemaVersion "0.3" is the live-verified GA value (Loom aws_agent_registry.py).
      const a2aCard = {
        protocolVersion: "0.3",
        name: "benefits-qa-agent",
        description: agentDescription.slice(0, 100),
        version: "1.0",
        url: props.benefitsQaA2aEndpointUrl,
        capabilities: { streaming: true },
        skills: [
          {
            id: "benefits-qa",
            name: "Benefits Q&A",
            description: "Answer PPO deductible, copay, OOP max, formulary and network questions.",
            tags: ["benefits", "payor", "member-services"],
          },
        ],
        defaultInputModes: ["text"],
        defaultOutputModes: ["text"],
      };

      const benefitsQaRecord = new CfnResource(this, "BenefitsQaAgentRecord", {
        type: "AWS::AgentRegistry::RegistryRecord",
        properties: {
          RegistryId: this.gaRegistry.registryId,
          Name: "benefits-qa-agent",
          DisplayName: "Benefits Q&A Agent",
          Description: agentDescription,
          RecordType: "AGENT",
          RecordVersion: "1.0.0",
          Descriptors: {
            A2aAgentCard: {
              Data: JSON.stringify(a2aCard),
              DataSchemaVersion: "0.3",
            },
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
