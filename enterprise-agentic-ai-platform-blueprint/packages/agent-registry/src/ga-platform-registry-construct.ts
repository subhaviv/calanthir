/*
 * Native GA Agent Registry producer used by the pipeline-owned RegistryStack.
 *
 * Uses AwsCustomResource calling bedrock-agentcore-control so registries
 * appear in the Bedrock AgentCore console (arn:aws:bedrock-agentcore:...).
 *
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
} from "aws-cdk-lib";
import {
  AccountPrincipal,
  CfnRole,
  CompositePrincipal,
  Effect,
  ManagedPolicy,
  PolicyStatement,
  Role,
} from "aws-cdk-lib/aws-iam";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
  PhysicalResourceIdReference,
} from "aws-cdk-lib/custom-resources";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

import {
  PLATFORM_TOOL_CATALOGUE,
  PLATFORM_TOOL_CATALOGUE_VERSION,
  resolveTargetArn,
  validateToolSpec,
  type ToolSpec,
} from "@agenticai/platform-tool-catalogue";

export interface GaPlatformRegistryTags {
  readonly applicationId: string;
  readonly agentId: string;
  readonly tenantId: string;
  readonly costCentre: string;
  readonly environment: string;
}

export interface GaPlatformRegistryConstructProps {
  readonly envName: "nonprod" | "prod";
  readonly workloadAccountIds: readonly string[];
  /** Account that owns the Workload pipeline's explicitly named synth role. */
  readonly registrySynthAccountId: string;
  /** Pipeline-owned environment-specific tool alias ARNs keyed by stable tool ID. */
  readonly toolTargetArns?: Readonly<Record<string, string>>;
  /**
   * Optional monotonic replacement generation for terminal Registry records.
   * Omitted records retain their original CloudFormation logical identity.
   */
  readonly recordGenerations?: Readonly<Record<string, number>>;
  readonly tags: GaPlatformRegistryTags;
}

export interface GaToolGovernanceDocument {
  readonly schemaVersion: "agenticai.tool-governance/1.0";
  readonly catalogueVersion: string;
  readonly toolId: string;
  readonly description: string;
  readonly desiredApprovalStatus: ToolSpec["approvalStatus"];
  readonly target: {
    readonly type: NonNullable<ToolSpec["toolType"]>;
    readonly arn: string;
  };
  readonly mcp: {
    readonly toolName: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
  };
  readonly authorization: {
    readonly defaultDecision: "DENY";
    readonly cedarPolicy: string;
    readonly allowedSubjects: readonly string[];
    readonly allowedGroups: readonly string[];
    readonly combination: "AUTHENTICATED" | "GROUP_ONLY";
  };
  readonly ownership: {
    readonly ownerTeam: string;
    readonly costCentre: string;
  };
}

/** Build the opaque governance document stored in a GA CUSTOM RegistryRecord. */
export function buildGaToolGovernanceDocument(
  tool: ToolSpec,
  platformAccountId: string,
  platformRegion: string,
  targetArnOverride?: string,
): GaToolGovernanceDocument {
  validateToolSpec(tool);
  const allowedGroups = [...(tool.allowedGroups ?? [])];
  return {
    schemaVersion: "agenticai.tool-governance/1.0",
    catalogueVersion: PLATFORM_TOOL_CATALOGUE_VERSION,
    toolId: tool.toolId,
    description: tool.description,
    desiredApprovalStatus: tool.approvalStatus,
    target: {
      type: tool.toolType ?? "lambda",
      arn:
        targetArnOverride ??
        resolveTargetArn(tool, platformAccountId, platformRegion),
    },
    mcp: {
      toolName: tool.toolId,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: "object" },
    },
    authorization: {
      defaultDecision: "DENY",
      cedarPolicy: tool.cedarPolicy.trim(),
      allowedSubjects: [],
      allowedGroups,
      combination: allowedGroups.length > 0 ? "GROUP_ONLY" : "AUTHENTICATED",
    },
    ownership: {
      ownerTeam: tool.ownerTeam,
      costCentre: tool.costCentre,
    },
  };
}

/**
 * Pipeline-owned GA Registry producer for one Platform environment.
 *
 * Creates the registry and records via bedrock-agentcore-control so they
 * appear in the Bedrock AgentCore console. Physical resource IDs are the
 * service-generated registryId / recordId values.
 */
export class GaPlatformRegistryConstruct extends Construct {
  readonly registryId: string;
  readonly registryArn: string;
  readonly recordIds: Readonly<Record<string, string>>;
  /** AwsCustomResource constructs keyed by toolId — use node.addDependency() for ordering. */
  readonly recordConstructs: Readonly<Record<string, AwsCustomResource>>;
  readonly recordIdParameters: Readonly<Record<string, StringParameter>>;
  readonly readerRole: Role;
  readonly readerExternalId: string;
  readonly parameterPrefix: string;

  constructor(
    scope: Construct,
    id: string,
    props: GaPlatformRegistryConstructProps,
  ) {
    super(scope, id);

    if (props.workloadAccountIds.length === 0) {
      throw new Error(
        "GaPlatformRegistryConstruct: workloadAccountIds must not be empty.",
      );
    }
    const workloadAccountIds = [...new Set(props.workloadAccountIds)].sort();
    for (const accountId of workloadAccountIds) {
      if (!/^\d{12}$/.test(accountId)) {
        throw new Error(
          `GaPlatformRegistryConstruct: workload account '${accountId}' must be 12 digits.`,
        );
      }
    }
    if (!/^\d{12}$/.test(props.registrySynthAccountId)) {
      throw new Error(
        "GaPlatformRegistryConstruct: registrySynthAccountId must be 12 digits.",
      );
    }
    if (props.toolTargetArns) {
      const expected = Object.keys(PLATFORM_TOOL_CATALOGUE).sort();
      const actual = Object.keys(props.toolTargetArns).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          "GaPlatformRegistryConstruct: toolTargetArns must exactly match the platform catalogue.",
        );
      }
    }
    const recordGenerations = props.recordGenerations ?? {};
    for (const [toolId, generation] of Object.entries(recordGenerations)) {
      if (!(toolId in PLATFORM_TOOL_CATALOGUE)) {
        throw new Error(
          `GaPlatformRegistryConstruct: record generation names unknown tool '${toolId}'.`,
        );
      }
      if (
        !Number.isSafeInteger(generation) ||
        generation < 2 ||
        generation > 999
      ) {
        throw new Error(
          `GaPlatformRegistryConstruct: record generation for '${toolId}' must be an integer from 2 through 999.`,
        );
      }
    }

    const stack = Stack.of(this);
    const tag = (resource: Construct): void => {
      for (const [key, value] of Object.entries({
        "application-id": props.tags.applicationId,
        "agent-id": props.tags.agentId,
        "tenant-id": props.tags.tenantId,
        "cost-centre": props.tags.costCentre,
        environment: props.tags.environment,
      })) {
        Tags.of(resource).add(key, value);
      }
    };

    const crPolicy = AwsCustomResourcePolicy.fromStatements([
      new PolicyStatement({
        sid: "AgentCoreRegistry",
        effect: Effect.ALLOW,
        actions: ["bedrock-agentcore:*"],
        resources: ["*"],
      }),
    ]);

    const nagSuppress = (cr: AwsCustomResource, reason: string) => {
      NagSuppressions.addResourceSuppressions(
        cr,
        [
          { id: "AwsSolutions-IAM5", reason },
          { id: "AwsSolutions-L1", reason: "SEC-006: CDK-managed custom-resource Lambda." },
        ],
        true,
      );
    };

    // ── Registry ──────────────────────────────────────────────────────────────
    const registryName = `agenticai-platform-${props.envName}-v1`;
    const registryCr = new AwsCustomResource(this, "Registry", {
      resourceType: "Custom::AgentCoreRegistry",
      installLatestAwsSdk: false,
      policy: crPolicy,
      onCreate: {
        service: "bedrock-agentcore-control",
        action: "CreateRegistry",
        parameters: {
          name: registryName,
          description: `Platform-owned GA Agent Registry (${props.envName}).`,
          authorizerType: "AWS_IAM",
        },
        physicalResourceId: PhysicalResourceId.fromResponse("registryId"),
      },
      onUpdate: {
        service: "bedrock-agentcore-control",
        action: "UpdateRegistry",
        parameters: {
          registryId: new PhysicalResourceIdReference(),
          description: `Platform-owned GA Agent Registry (${props.envName}).`,
        },
        physicalResourceId: PhysicalResourceId.fromResponse("registryId"),
      },
      onDelete: {
        service: "bedrock-agentcore-control",
        action: "DeleteRegistry",
        parameters: { registryId: new PhysicalResourceIdReference() },
        ignoreErrorCodesMatching: "ResourceNotFoundException",
      },
    });
    nagSuppress(registryCr, "SEC-041: bedrock-agentcore registry APIs have no resource ARN at synth time.");

    this.registryId = registryCr.getResponseField("registryId");
    this.registryArn = `arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}:registry/${this.registryId}`;

    // ── Records ───────────────────────────────────────────────────────────────
    const recordIds: Record<string, string> = {};
    const recordConstructs: Record<string, AwsCustomResource> = {};
    const recordIdParameters: Record<string, StringParameter> = {};
    this.parameterPrefix = `/agenticai/registry/v1/${props.envName}`;

    const parameter = (
      constructId: string,
      name: string,
      value: string,
      description: string,
    ): StringParameter => {
      const result = new StringParameter(this, constructId, {
        parameterName: `${this.parameterPrefix}/${name}`,
        stringValue: value,
        description,
      });
      result.applyRemovalPolicy(RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE);
      tag(result);
      return result;
    };

    for (const tool of Object.values(PLATFORM_TOOL_CATALOGUE).sort(
      (left, right) => left.toolId.localeCompare(right.toolId),
    )) {
      const governance = buildGaToolGovernanceDocument(
        tool,
        stack.account,
        stack.region,
        props.toolTargetArns?.[tool.toolId],
      );
      const generation = recordGenerations[tool.toolId];
      const recordConstructId =
        generation === undefined
          ? `Record-${tool.toolId}`
          : `Record-${tool.toolId}-generation-${generation}`;

      const recordCr = new AwsCustomResource(this, recordConstructId, {
        resourceType: "Custom::AgentCoreRegistryRecord",
        installLatestAwsSdk: false,
        policy: crPolicy,
        onCreate: {
          service: "bedrock-agentcore-control",
          action: "CreateRegistryRecord",
          parameters: {
            registryId: this.registryId,
            name: tool.toolId,
            description: tool.description,
            descriptorType: "CUSTOM",
            descriptors: { custom: { inlineContent: JSON.stringify(governance) } },
            recordVersion: "2.0.0",
          },
          physicalResourceId: PhysicalResourceId.fromResponse("recordArn"),
        },
        onUpdate: {
          service: "bedrock-agentcore-control",
          action: "UpdateRegistryRecord",
          parameters: {
            registryId: this.registryId,
            recordId: new PhysicalResourceIdReference(),
            description: tool.description,
            descriptorType: "CUSTOM",
            descriptors: { custom: { inlineContent: JSON.stringify(governance) } },
            recordVersion: "2.0.0",
          },
          physicalResourceId: PhysicalResourceId.fromResponse("recordArn"),
        },
        onDelete: {
          service: "bedrock-agentcore-control",
          action: "DeleteRegistryRecord",
          parameters: {
            registryId: this.registryId,
            recordId: new PhysicalResourceIdReference(),
          },
          ignoreErrorCodesMatching: "ResourceNotFoundException",
        },
      });
      recordCr.node.addDependency(registryCr);
      nagSuppress(recordCr, "SEC-042: bedrock-agentcore registry record APIs have no resource ARN at synth time.");

      recordConstructs[tool.toolId] = recordCr;
      recordIds[tool.toolId] = recordCr.getResponseField("recordArn");
      recordIdParameters[tool.toolId] = parameter(
        `RecordIdParameter-${tool.toolId}`,
        `records/${tool.toolId}/id`,
        recordCr.getResponseField("recordArn"),
        `GA Agent Registry record ARN for ${tool.toolId}.`,
      );
    }
    this.recordIds = recordIds;
    this.recordConstructs = recordConstructs;
    this.recordIdParameters = recordIdParameters;

    // ── Reader role ───────────────────────────────────────────────────────────
    this.readerExternalId = `agenticai-registry-v1-${props.envName}-${stack.account}`;
    const workloadPrincipals = workloadAccountIds.map(
      (accountId) => new AccountPrincipal(accountId),
    );
    this.readerRole = new Role(this, "RegistryReaderRole", {
      roleName: `AgenticAI-RegistryReader-${props.envName}`,
      assumedBy: new CompositePrincipal(...workloadPrincipals),
      description: `Read-only GA Agent Registry role for ${props.envName} Workstreams.`,
      maxSessionDuration: Duration.hours(1),
    });
    tag(this.readerRole);

    const cfnReaderRole = this.readerRole.node.defaultChild as CfnRole;
    cfnReaderRole.assumeRolePolicyDocument = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "AllowWorkstreamRegistryValidators",
          Effect: "Allow",
          Principal: {
            AWS: workloadAccountIds.map(
              (accountId) => `arn:${stack.partition}:iam::${accountId}:root`,
            ),
          },
          Action: "sts:AssumeRole",
          Condition: {
            StringEquals: {
              "sts:ExternalId": this.readerExternalId,
            },
            StringLike: {
              "aws:PrincipalArn": workloadAccountIds.map(
                (accountId) =>
                  `arn:${stack.partition}:iam::${accountId}:role/AgenticAI-D03-*-RegistryValidator`,
              ),
              "sts:RoleSessionName": "registry-*",
            },
          },
        },
        {
          Sid: "AllowWorkloadPipelineRegistryResolution",
          Effect: "Allow",
          Principal: {
            AWS: `arn:${stack.partition}:iam::${props.registrySynthAccountId}:root`,
          },
          Action: "sts:AssumeRole",
          Condition: {
            StringEquals: {
              "sts:ExternalId": `agenticai-registry-synth-v1-${props.envName}-${stack.account}`,
            },
            ArnEquals: {
              "aws:PrincipalArn": `arn:${stack.partition}:iam::${props.registrySynthAccountId}:role/AgenticAI-WLP-${props.tags.tenantId}-${props.tags.agentId}-RegistrySynth`,
            },
            StringLike: {
              "sts:RoleSessionName": "registry-synth-*",
            },
          },
        },
      ],
    };

    const readerPolicy = new ManagedPolicy(this, "RegistryReaderPolicy", {
      managedPolicyName: `AgenticAI-RegistryReader-${props.envName}`,
      description: `Read-only access to the ${props.envName} GA Agent Registry.`,
      statements: [
        new PolicyStatement({
          sid: "ReadRegistry",
          effect: Effect.ALLOW,
          actions: [
            "bedrock-agentcore:GetRegistry",
            "bedrock-agentcore:ListRegistryRecords",
            "bedrock-agentcore:GetRegistryRecord",
          ],
          resources: [
            this.registryArn,
            `${this.registryArn}/record/*`,
          ],
        }),
        new PolicyStatement({
          sid: "ReadRegistryDiscoveryParameters",
          effect: Effect.ALLOW,
          actions: ["ssm:GetParameters"],
          resources: [
            `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter${this.parameterPrefix}/*`,
          ],
        }),
      ],
    });
    this.readerRole.addManagedPolicy(readerPolicy);
    NagSuppressions.addResourceSuppressions(
      readerPolicy,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "SEC-030: Record ARNs are service-generated; wildcard is constrained under one Registry ARN.",
        },
      ],
      true,
    );

    // ── SSM parameters ────────────────────────────────────────────────────────
    const registryIdParameter = parameter(
      "RegistryIdParameter",
      "id",
      this.registryId,
      `GA Agent Registry id for ${props.envName}.`,
    );
    const registryArnParameter = parameter(
      "RegistryArnParameter",
      "arn",
      this.registryArn,
      `GA Agent Registry ARN for ${props.envName}.`,
    );
    const readerRoleArnParameter = parameter(
      "ReaderRoleArnParameter",
      "reader-role-arn",
      this.readerRole.roleArn,
      `GA Agent Registry reader role ARN for ${props.envName}.`,
    );
    const readerExternalIdParameter = parameter(
      "ReaderExternalIdParameter",
      "reader-external-id",
      this.readerExternalId,
      `GA Agent Registry reader ExternalId for ${props.envName}.`,
    );

    // ── Outputs ───────────────────────────────────────────────────────────────
    new CfnOutput(this, "RegistryId", { value: this.registryId });
    new CfnOutput(this, "RegistryArn", { value: this.registryArn });
    new CfnOutput(this, "RegistryReaderRoleArn", {
      value: this.readerRole.roleArn,
    });
    new CfnOutput(this, "RegistryIdParameterName", {
      value: registryIdParameter.parameterName,
    });
    new CfnOutput(this, "RegistryArnParameterName", {
      value: registryArnParameter.parameterName,
    });
    new CfnOutput(this, "RegistryReaderRoleArnParameterName", {
      value: readerRoleArnParameter.parameterName,
    });
    new CfnOutput(this, "RegistryReaderExternalIdParameterName", {
      value: readerExternalIdParameter.parameterName,
    });
  }
}
