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

  /**
   * HTTPS endpoint of the workload API Gateway fronting the Halo
   * (providers / patient-journey) Runtime. When supplied a RegistryRecord is
   * created in the GA registry so the agent becomes discoverable (auto-approves
   * in nonprod; a curator approves in prod).
   *
   * The runtime ARN is passed via the context key
   * `agenticai/haloPatientJourneyRuntimeArn`.
   *
   * Omit until the Halo workload stack is deployed and the endpoint is known.
   */
  readonly haloPatientJourneyA2aEndpointUrl?: string;

  /**
   * When true, publish the 5 hosted HCLS / PubMed MCP tools as discoverable
   * `CUSTOM` governance records in the GA registry (auto-approves in nonprod;
   * a curator approves in prod).
   *
   * These tools are LIVE on the enterprise governance gateway
   * (`enterprise-mcp-governance-gateway`, HclsConnectorStack) — one governed
   * MCP-server target per server, with a Cedar read permit per tool. That
   * gateway is the source of truth; these registry records only make the tools
   * DISCOVERABLE in the GA registry and do NOT re-define or re-govern them.
   *
   * Unlike catalogue (Lambda-target) tools, these have NO Lambda alias — the
   * target is the static gateway MCP endpoint — so they are hand-written here
   * rather than emitted from PLATFORM_TOOL_CATALOGUE (which assumes a Lambda
   * `:PROD` alias and is asserted by phase-22 conformance). Keep the endpoints
   * and tool lists in sync with HclsConnectorStack's HCLS_TARGETS.
   *
   * Pass via context key `agenticai/registerHclsTools=true`.
   */
  readonly registerHclsTools?: boolean;
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

    // ── Halo: Patient Journey agent record ─────────────────────────────────
    // Providers tenant, patient-journey agent (runtime np_providers_patient_journey).
    // RecordType AGENT so it shows as an agent, not a tool. Auto-approves in
    // nonprod (APPROVE_ALL); a curator approves in prod. Pass:
    //   agenticai/haloPatientJourneyA2aEndpointUrl — workload API Gateway URL
    //   agenticai/haloPatientJourneyRuntimeArn     — AgentCore Runtime ARN
    if (props.haloPatientJourneyA2aEndpointUrl) {
      const haloRuntimeArn =
        typeof this.node.tryGetContext("agenticai/haloPatientJourneyRuntimeArn") === "string"
          ? String(this.node.tryGetContext("agenticai/haloPatientJourneyRuntimeArn"))
          : `arn:aws:bedrock-agentcore:${this.region}:${props.workloadAccountIds[0]}:agent-runtime/np_providers_patient_journey-pending`;

      const haloDescription =
        "Halo: Patient Journey — turns an ambient ED summary into a governed, " +
        "auditable, cost-attributed patient-journey brief, calling governed EHR " +
        "and imaging tools with per-call entitlement, audit, and cost attribution.";

      // A2A agent card — dataSchemaVersion "0.3" (live-verified GA value).
      const haloA2aCard = {
        protocolVersion: "0.3",
        name: "halo-patient-journey",
        description: haloDescription.slice(0, 100),
        version: "1.0",
        url: props.haloPatientJourneyA2aEndpointUrl,
        capabilities: { streaming: true },
        skills: [
          {
            id: "ed-patient-journey",
            name: "ED Patient-Journey Synthesis",
            description:
              "Assemble the structured EHR + imaging record the ambient scribe missed " +
              "into a context-first patient-journey brief with source attribution.",
            tags: ["clinical", "providers", "patient-journey", "ehr", "imaging"],
          },
        ],
        defaultInputModes: ["text"],
        defaultOutputModes: ["text"],
      };

      const haloRecord = new CfnResource(this, "HaloPatientJourneyAgentRecord", {
        type: "AWS::AgentRegistry::RegistryRecord",
        properties: {
          RegistryId: this.gaRegistry.registryId,
          Name: "halo-patient-journey",
          DisplayName: "Halo: Patient Journey",
          Description: haloDescription,
          RecordType: "AGENT",
          RecordVersion: "1.0.0",
          Descriptors: {
            A2aAgentCard: {
              Data: JSON.stringify(haloA2aCard),
              DataSchemaVersion: "0.3",
            },
          },
          Tags: [
            { Key: "application-id", Value: props.applicationId },
            { Key: "agent-id", Value: "patient-journey" },
            { Key: "tenant-id", Value: "providers" },
            { Key: "cost-centre", Value: "providers" },
            { Key: "environment", Value: props.envName },
            { Key: "owner-team", Value: "providers" },
          ],
        },
      });
      haloRecord.addDependsOn(this.gaRegistry.registry);
      haloRecord.applyRemovalPolicy(RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE);

      // Avoid an unused-variable error while keeping the ARN explicit in the
      // record's provenance (it is carried in the A2A url + tags today; the
      // ARN is reserved for a future direct-invoke descriptor).
      void haloRuntimeArn;

      new CfnOutput(this, "HaloPatientJourneyRecordId", {
        value: haloRecord.getAtt("RecordId").toString(),
        description: "GA Registry record ID for the Halo: Patient Journey agent.",
      });
    }

    // ── HCLS / PubMed MCP tools ────────────────────────────────────────────
    // The 5 hosted healthcare MCP servers (PubMed, Clinical Trials, ICD-10, NPI
    // Registry, CMS Coverage) are LIVE as governed MCP-server targets on the
    // enterprise governance gateway (enterprise-mcp-governance-gateway →
    // HclsConnectorStack). That gateway is the source of truth: Cognito JWT
    // auth + one ENFORCE Cedar read-permit per tool + request/response
    // interceptors apply on every call, and tools/list + a real PubMed call are
    // verified end-to-end through it.
    //
    // These records only make those tools DISCOVERABLE in the GA registry. They
    // are RecordType CUSTOM (tools surface as tools, not agents), carrying a
    // governance descriptor whose target is the gateway MCP endpoint — NOT a
    // Lambda alias — which is why they are hand-written here instead of being
    // emitted from PLATFORM_TOOL_CATALOGUE (that path assumes a Lambda :PROD
    // alias and is asserted by phase-22 conformance; adding non-Lambda tools
    // there would break it). Keep endpoints + tool lists in sync with
    // HclsConnectorStack.HCLS_TARGETS. Auto-approves in nonprod; curator in prod.
    if (props.registerHclsTools) {
      // Mirror of HclsConnectorStack.HCLS_TARGETS (gateway = source of truth).
      const hclsTargets: ReadonlyArray<{
        toolId: string;
        displayName: string;
        endpoint: string;
        international: boolean;
        description: string;
        tools: readonly string[];
      }> = [
        {
          toolId: "tool-pubmed",
          displayName: "PubMed",
          endpoint: "https://pubmed.mcp.claude.com/mcp",
          international: true,
          description:
            "PubMed biomedical literature search. Query by clinical concept, never patient identifiers.",
          tools: [
            "search_articles",
            "get_article_metadata",
            "find_related_articles",
            "lookup_article_by_citation",
            "convert_article_ids",
            "get_full_text_article",
            "get_copyright_status",
          ],
        },
        {
          toolId: "tool-clinical-trials",
          displayName: "ClinicalTrials",
          endpoint: "https://hcls.mcp.claude.com/clinical_trials/mcp",
          international: true,
          description:
            "Clinical trials registry search. Query by condition/criteria, never patient identifiers.",
          tools: [
            "search_trials",
            "get_trial_details",
            "search_by_sponsor",
            "search_investigators",
            "analyze_endpoints",
            "search_by_eligibility",
          ],
        },
        {
          toolId: "tool-icd10",
          displayName: "Icd10",
          endpoint: "https://hcls.mcp.claude.com/icd10_codes/mcp",
          international: false,
          description:
            "ICD-10 code lookup/validation (US-centric ICD-10-CM). For coding/RCM use cases.",
          tools: [
            "lookup_code",
            "search_codes",
            "validate_code",
            "get_hierarchy",
            "get_by_category",
            "get_by_body_system",
          ],
        },
        {
          toolId: "tool-npi-registry",
          displayName: "NpiRegistry",
          endpoint: "https://hcls.mcp.claude.com/npi_registry/mcp",
          international: false,
          description:
            "NPI provider registry lookup (US-only CMS NPI). For US coding/RCM use cases.",
          tools: ["npi_validate", "npi_lookup", "npi_search"],
        },
        {
          toolId: "tool-cms-coverage",
          displayName: "CmsCoverage",
          endpoint: "https://hcls.mcp.claude.com/cms_coverage/mcp",
          international: false,
          description:
            "CMS coverage/policy lookup (US-centric). For coding/PA/RCM use cases.",
          tools: [
            "search_national_coverage",
            "search_local_coverage",
            "get_coverage_document",
            "get_contractors",
            "get_whats_new_report",
            "batch_get_ncds",
            "sad_exclusion_list",
          ],
        },
      ];

      for (const target of hclsTargets) {
        // CUSTOM governance descriptor. The authoritative enforcement lives on
        // the gateway (ENFORCE Cedar, read permit per tool); this document
        // records the governance posture for discovery/audit, with the gateway
        // MCP endpoint as the target (type "mcp-server", no Lambda alias).
        const governance = {
          schemaVersion: "agenticai.tool-governance/1.0",
          toolId: target.toolId,
          description: target.description,
          desiredApprovalStatus: "approved",
          target: {
            type: "mcp-server",
            endpoint: target.endpoint,
            // Discovery/enforcement is on the enterprise governance gateway;
            // this record does not itself route traffic.
            gatewayStack: "enterprise-mcp-governance-gateway/HclsConnectorStack",
          },
          mcp: {
            // Tools are namespaced <DisplayName>___<tool> on the gateway.
            server: target.displayName,
            tools: target.tools.map((name) => ({
              toolName: `${target.displayName}___${name}`,
              description: target.description,
            })),
          },
          authorization: {
            // Public read-only reference servers: an unconditional READ permit
            // per tool for authenticated gateway users (mirrors the live Cedar
            // permits in HclsConnectorStack).
            defaultDecision: "DENY",
            allowedSubjects: [],
            allowedGroups: [],
            readOnly: true,
          },
          ownership: {
            ownerTeam: "platform",
            costCentre: props.costCentre,
          },
          metadata: {
            international: target.international,
            hostedBy: "anthropic-hosted-hcls-mcp",
          },
        };

        const record = new CfnResource(this, `HclsToolRecord-${target.toolId}`, {
          type: "AWS::AgentRegistry::RegistryRecord",
          properties: {
            RegistryId: this.gaRegistry.registryId,
            Name: target.toolId,
            DisplayName: target.displayName,
            Description: target.description,
            RecordType: "CUSTOM",
            RecordVersion: "1.0.0",
            Descriptors: {
              Custom: {
                Data: JSON.stringify(governance),
              },
            },
            Tags: [
              { Key: "application-id", Value: props.applicationId },
              { Key: "agent-id", Value: "hcls-tools" },
              { Key: "tenant-id", Value: "platform" },
              { Key: "cost-centre", Value: props.costCentre },
              { Key: "environment", Value: props.envName },
              { Key: "owner-team", Value: "platform" },
            ],
          },
        });
        record.addDependsOn(this.gaRegistry.registry);
        record.applyRemovalPolicy(RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE);

        new CfnOutput(this, `HclsToolRecordId-${target.toolId}`, {
          value: record.getAtt("RecordId").toString(),
          description: `GA Registry record ID for the ${target.displayName} HCLS tool.`,
        });
      }
    }
  }
}
