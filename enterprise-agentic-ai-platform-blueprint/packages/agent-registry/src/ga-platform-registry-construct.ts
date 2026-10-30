/*
 * Native GA Agent Registry producer used by the pipeline-owned RegistryStack.
 *
 * This construct is deliberately additive during the blue-green migration. It
 * does not replace or rename the existing DynamoDB AgentCoreRegistryConstruct.
 *
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */
import {
  CfnOutput,
  CfnResource,
  CustomResource,
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
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Provider } from "aws-cdk-lib/custom-resources";
import { createHash } from "node:crypto";
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
 * Resources use RetainExceptOnCreate semantics: a failed first deployment
 * cleans itself up, while a later stack rollback cannot destroy approved
 * governance state. The old DynamoDB registry remains the rollback path until
 * a live rollback deployment from the R2 revision passes independently.
 */
export class GaPlatformRegistryConstruct extends Construct {
  readonly registry: CfnResource;
  readonly registryId: string;
  readonly registryArn: string;
  readonly records: Readonly<Record<string, CfnResource>>;
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
    const tags = {
      "application-id": props.tags.applicationId,
      "agent-id": props.tags.agentId,
      "tenant-id": props.tags.tenantId,
      "cost-centre": props.tags.costCentre,
      environment: props.tags.environment,
    };
    const cfnTags = Object.entries(tags)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([Key, Value]) => ({ Key, Value }));
    const tag = (resource: Construct): void => {
      for (const [key, value] of Object.entries(tags)) {
        Tags.of(resource).add(key, value);
      }
    };

    const registryName = `agenticai-platform-${props.envName}-v1`;
    this.registry = new CfnResource(this, "Registry", {
      type: "AWS::AgentRegistry::Registry",
      properties: {
        Name: registryName,
        Description: `Platform-owned GA Agent Registry (${props.envName}).`,
        AuthorizerType: "AWS_IAM",
        ApprovalConfiguration: { AutoApprovalRules: ["APPROVE_ALL"] },
        Tags: cfnTags,
      },
    });
    this.registry.applyRemovalPolicy(RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE);
    this.registryId = this.registry.getAtt("RegistryId").toString();
    this.registryArn = this.registry.getAtt("RegistryArn").toString();

    const records: Record<string, CfnResource> = {};
    const toSubmit: {
      toolId: string;
      record: CfnResource;
      descriptorSha256: string;
    }[] = [];
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
      const record = new CfnResource(this, recordConstructId, {
        type: "AWS::AgentRegistry::RegistryRecord",
        properties: {
          RegistryId: this.registryId,
          Name: tool.toolId,
          DisplayName: tool.toolId,
          Description: tool.description,
          RecordType: "CUSTOM",
          RecordVersion: "2.0.0",
          Descriptors: {
            Custom: {
              Data: JSON.stringify(governance),
            },
          },
          Tags: cfnTags,
        },
      });
      record.addDependency(this.registry);
      record.applyRemovalPolicy(RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE);
      records[tool.toolId] = record;
      if (tool.approvalStatus === "approved") {
        toSubmit.push({
          toolId: tool.toolId,
          record,
          descriptorSha256: createHash("sha256")
            .update(JSON.stringify(governance), "utf8")
            .digest("hex"),
        });
      }
      recordIdParameters[tool.toolId] = parameter(
        `RecordIdParameter-${tool.toolId}`,
        `records/${tool.toolId}/id`,
        record.getAtt("RecordId").toString(),
        `GA Agent Registry record id for ${tool.toolId}.`,
      );
    }
    this.records = records;
    this.recordIdParameters = recordIdParameters;

    // CloudFormation creates (and every descriptor update returns) a record in
    // DRAFT. The Registry's APPROVE_ALL rule applies only on submission, so a
    // record nothing submits never becomes APPROVED and no Workstream Gateway
    // can subscribe to it. In nonprod, submit every catalogue record whose
    // desired status is `approved`; APPROVE_ALL then approves it. Prod is left
    // to a curator, because submitting there would auto-approve too.
    if (props.envName === "nonprod" && toSubmit.length > 0) {
      const submitRole = new Role(this, "RecordSubmitterRole", {
        assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
        description: `Submits approved catalogue records in the ${props.envName} GA Agent Registry.`,
        managedPolicies: [
          ManagedPolicy.fromAwsManagedPolicyName(
            "service-role/AWSLambdaBasicExecutionRole",
          ),
        ],
        inlinePolicies: {
          SubmitCatalogueRecords: new PolicyDocument({
            statements: [
              new PolicyStatement({
                sid: "SubmitCatalogueRecords",
                effect: Effect.ALLOW,
                actions: [
                  "agent-registry:GetRegistryRecord",
                  "agent-registry:SubmitRegistryRecordForApproval",
                ],
                resources: [`${this.registryArn}/record/*`],
              }),
            ],
          }),
        },
      });
      const submitFn = new LambdaFunction(this, "RecordSubmitterFn", {
        runtime: Runtime.NODEJS_22_X,
        handler: "index.handler",
        timeout: Duration.minutes(2),
        memorySize: 256,
        description:
          "Submits DRAFT catalogue records for approval (APPROVE_ALL approves on submit).",
        code: Code.fromInline(RECORD_SUBMITTER_HANDLER),
        role: submitRole,
      });
      const submitProvider = new Provider(this, "RecordSubmitterProvider", {
        onEventHandler: submitFn,
      });
      for (const item of toSubmit) {
        new CustomResource(this, `SubmitRecord-${item.toolId}`, {
          serviceToken: submitProvider.serviceToken,
          resourceType: "Custom::AgentRegistryRecordSubmission",
          properties: {
            registryId: this.registryId,
            recordId: item.record.getAtt("RecordId").toString(),
            toolId: item.toolId,
            // Re-run on every descriptor change: an update puts the record
            // back in DRAFT.
            descriptorSha256: item.descriptorSha256,
          },
        });
      }
      NagSuppressions.addResourceSuppressions(
        [submitRole, submitFn, submitProvider],
        [
          {
            id: "AwsSolutions-IAM4",
            reason:
              "SEC-010: AWSLambdaBasicExecutionRole is the documented logging policy for the record-submitter Lambda and CDK provider framework Lambdas.",
          },
          {
            id: "AwsSolutions-IAM5",
            reason:
              "SEC-030: RegistryRecord IDs are service-generated, so the wildcard is constrained under one Registry ARN; SEC-029: the Provider framework invokes versions of the single submitter Lambda.",
          },
          {
            id: "AwsSolutions-L1",
            reason:
              "SEC-006: Node.js 22 for the inline submitter; the Provider framework runtime is managed by aws-cdk-lib.",
          },
          {
            id: "NIST.800.53.R5-LambdaConcurrency",
            reason: "SEC-007: Provisioning-time Lambda invoked only by CloudFormation.",
          },
          {
            id: "NIST.800.53.R5-LambdaDLQ",
            reason: "SEC-008: CloudFormation surfaces custom-resource failures.",
          },
          {
            id: "NIST.800.53.R5-LambdaInsideVPC",
            reason:
              "SEC-009: The GA Agent Registry control plane is reached only during deployment.",
          },
          {
            id: "NIST.800.53.R5-IAMNoInlinePolicy",
            reason:
              "The submitter's single-statement grant is inline so the Registry reader policy stays this stack's only customer managed policy; the CDK Provider framework attaches its own invoke grant as a default policy.",
          },
        ],
        true,
      );
    }

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
          sid: "ReadRegistryMetadata",
          effect: Effect.ALLOW,
          actions: [
            "agent-registry:GetRegistry",
            "agent-registry:ListRegistryRecords",
          ],
          resources: [this.registryArn],
        }),
        new PolicyStatement({
          sid: "ReadRegistryRecords",
          effect: Effect.ALLOW,
          actions: [
            "agent-registry:GetRegistryRecord",
            "agent-registry:GetDiscoverableRegistryRecord",
          ],
          resources: [`${this.registryArn}/record/*`],
        }),
        new PolicyStatement({
          sid: "ReadRegistryTags",
          effect: Effect.ALLOW,
          actions: ["agent-registry:ListTagsForResource"],
          resources: [this.registryArn, `${this.registryArn}/record/*`],
        }),
        new PolicyStatement({
          sid: "DiscoverApprovedRegistryRecords",
          effect: Effect.ALLOW,
          actions: [
            "agent-registry:ListDiscoverableRegistryRecords",
            "agent-registry:SearchDiscoverableRegistryRecords",
          ],
          resources: [this.registryArn],
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
            "SEC-030: RegistryRecord IDs are service-generated and SSM discovery uses a versioned environment prefix; both wildcards are constrained under one Registry ARN or one exact parameter path, and conformance tests pin every action/resource pair.",
        },
      ],
      true,
    );

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

/**
 * Inline Provider onEvent handler for Custom::AgentRegistryRecordSubmission.
 *
 * GA Agent Registry control-plane REST (signing service `agent-registry`):
 *   GET  /registries/<rid>/records/<recId>
 *   POST /registries/<rid>/records/<recId>/submit-for-approval
 * Built-in SigV4 (no @aws-sdk import), the same approach as the Workstream
 * Gateway's Registry validator: the runtime's bundled SDK version must not
 * decide whether this newly released service is reachable.
 *
 * Create/Update: a DRAFT record is submitted; the call then waits for
 * APPROVED and fails closed on any other end state, so a deploy never reports
 * success for a record no Gateway can subscribe to. Delete is a no-op: the
 * stack retains records, and approval state is not undone.
 */
export const RECORD_SUBMITTER_HANDLER = `
const https = require('https');
const crypto = require('crypto');
const NL = String.fromCharCode(10);
function hmac(key, str) { return crypto.createHmac('sha256', key).update(str, 'utf8').digest(); }
function hash(str) { return crypto.createHash('sha256').update(str, 'utf8').digest('hex'); }

function call(method, path, body) {
  const region = process.env.AWS_REGION;
  const host = 'agent-registry-control.' + region + '.api.aws';
  const service = 'agent-registry';
  const payload = body === undefined ? '' : JSON.stringify(body);
  const amzDate = new Date().toISOString().replace(/[:-]|[.][0-9]{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);
  const headers = { host: host, 'x-amz-date': amzDate };
  if (payload) headers['content-type'] = 'application/json';
  if (process.env.AWS_SESSION_TOKEN) headers['x-amz-security-token'] = process.env.AWS_SESSION_TOKEN;
  const keys = Object.keys(headers).sort();
  const canonicalHeaders = keys.map(function (k) { return k + ':' + headers[k] + NL; }).join('');
  const signedHeaders = keys.join(';');
  const canonicalUri = path.split('/').map(function (s) { return s === '' ? '' : encodeURIComponent(decodeURIComponent(s)); }).join('/');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, hash(payload)].join(NL);
  const scope = dateStamp + '/' + region + '/' + service + '/aws4_request';
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonicalRequest)].join(NL);
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + process.env.AWS_SECRET_ACCESS_KEY, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign, 'utf8').digest('hex');
  const reqHeaders = Object.assign({}, headers, {
    Authorization: 'AWS4-HMAC-SHA256 Credential=' + process.env.AWS_ACCESS_KEY_ID + '/' + scope +
      ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
  });
  delete reqHeaders.host;
  return new Promise(function (resolve, reject) {
    const req = https.request({ host: host, path: path, method: method, headers: reqHeaders }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(method + ' ' + path + ' HTTP ' + res.statusCode + ': ' + text));
          return;
        }
        resolve(text ? JSON.parse(text) : {});
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

exports.handler = async function (event) {
  const p = event.ResourceProperties || {};
  const physicalId = 'submit-' + (p.recordId || event.PhysicalResourceId || 'unknown');
  if (event.RequestType === 'Delete') return { PhysicalResourceId: event.PhysicalResourceId || physicalId };
  if (!/^[A-Za-z0-9]{16}$/.test(p.registryId || '') || !/^[A-Za-z0-9]{12}$/.test(p.recordId || '')) {
    throw new Error('AgentRegistryRecordSubmission: registryId/recordId shape is invalid');
  }
  const path = '/registries/' + p.registryId + '/records/' + p.recordId;
  let record = await call('GET', path);
  if (record.name !== p.toolId) {
    throw new Error('AgentRegistryRecordSubmission: record ' + p.recordId + ' is ' + record.name + ', expected ' + p.toolId);
  }
  if (record.status === 'DRAFT') {
    await call('POST', path + '/submit-for-approval', {});
  } else if (record.status !== 'APPROVED' && record.status !== 'PENDING_APPROVAL') {
    throw new Error('AgentRegistryRecordSubmission: ' + p.toolId + ' is ' + record.status + '; only DRAFT records are submitted');
  }
  for (let i = 0; i < 20 && record.status !== 'APPROVED'; i++) {
    await sleep(3000);
    record = await call('GET', path);
  }
  if (record.status !== 'APPROVED') {
    throw new Error('AgentRegistryRecordSubmission: ' + p.toolId + ' ended ' + record.status + ' (expected APPROVED under APPROVE_ALL)');
  }
  return { PhysicalResourceId: physicalId, Data: { Status: record.status } };
};
`;
