/**
 * @agenticai/platform-tool-catalogue — Platform Tool Catalogue SSOT.
 *
 * Single source of truth for every tool any workstream may subscribe to via
 * `D03TenantAllocation.allowedToolIds`. Authoritative at synth; unknown ids
 * fail the CDK synth with an actionable error.
 *
 * Same pattern as `packages/platform-baselines/src/allowed-models.ts`:
 *   - TypeScript constant is authoritative
 *   - Conformance + unit tests catch drift
 *   - Downstream consumers (per-workstream AgentCore Gateway synth) resolve
 *     their subscribed subset via `resolveSubscribedTools()`.
 *
 * Architectural decisions encoded here:
 *   - Q1 (hybrid owner placement): platform-account tools omit `targetAccountId`;
 *     workload-account tools set it explicitly (12-digit string).
 *   - Q3 (per-tool Cedar, union-ed at synth): every ToolSpec carries a Cedar
 *     snippet; subscribed subsets compose into the Gateway policy document.
 *   - Q5 (pin via Lambda alias 'PROD'): `targetArn` MUST end with an alias;
 *     synth-time validation asserts.
 *
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import { createHash } from "node:crypto";

export type ToolId = string; // branded string; keep simple for v1

/**
 * A tool spec in the Platform Tool Catalogue. Immutable at synth.
 *
 * Q5 decision (pin via Lambda alias 'PROD'): targetArn MUST include an alias
 * suffix (e.g. `:PROD`). Synth-time validation asserts.
 *
 * Q1 decision (hybrid — platform-default, workload-targets explicit via
 * `targetAccountId`): if a tool lives outside the platform account, the
 * caller MUST set `targetAccountId` explicitly. Platform-account tools
 * omit it; synth emits the platform account id automatically.
 *
 * Q3 decision (per-tool Cedar, union-ed at synth): `cedarPolicy` is the
 * Cedar policy snippet that governs calls TO this tool. Each subscribed
 * workstream's Gateway policy document is built by union-ing the cedarPolicy
 * strings of every tool the workstream subscribed to.
 */
export type ToolType = "lambda" | "agent-a2a";

export interface ToolSpec {
  readonly toolId: ToolId; // unique within catalogue; kebab-case pattern
  /** Z7-K: kind of tool. Defaults to 'lambda'. 'agent-a2a' targets a peer-agent A2A endpoint. */
  readonly toolType?: ToolType;
  /** Lambda alias ARN. Platform-owned targets use both `${PLATFORM_REGION}` and `${PLATFORM_ACCOUNT_ID}` placeholders. */
  readonly targetArn: string;
  readonly targetAccountId?: string; // optional; when present the tool lives cross-account (platform-workload or workload-workload)
  /**
   * True when the target Lambda and its alias are deployed by the tool's own
   * stack (e.g. StrandsDeciderStack). The registry stack then builds no stub
   * function for it: the GA record points at the resolved `targetArn`, and
   * Gateway invoke grants are added to that existing alias. Undefined/false
   * keeps the default of a pipeline-owned, environment-isolated function.
   */
  readonly externallyProvisioned?: boolean;
  readonly cedarPolicy: string; // per-tool Cedar snippet, union-ed into Gateway policy at synth
  readonly ownerTeam: string; // e.g. 'platform-ai', 'retail', 'hr'
  readonly costCentre: string; // CUR attribution passthrough
  readonly description: string; // human-readable; appears in Registry DDB
  readonly approvalStatus: "approved" | "experimental" | "deprecated";
  readonly inputSchema?: Record<string, unknown>; // JSONSchema draft-07; passed into CreateGatewayTarget.targetConfiguration.mcp.lambda.toolSchema.inlinePayload
  /**
   * Z7-K: when toolType === 'agent-a2a' this is the peer agent's A2A
   * endpoint URL (must be HTTPS). When 'lambda', leave undefined.
   */
  readonly a2aEndpointUrl?: string;
  /**
   * Phase Q (v0.6.0) — second-layer entitlement: the set of Cognito group
   * names whose JWTs are permitted to invoke this tool. Empty/undefined ⇒
   * any authenticated principal allowed (the existing v0.5.0 behaviour).
   * When present, two things change:
   *   1. The composed Cedar bundle binds the permit to `principal in
   *      CognitoGroup::"<g>"` instead of an unconditional permit.
   *   2. The workstream Gateway stack throws at synth unless
   *      `cognitoDiscoveryUrl` is supplied (CUSTOM_JWT becomes mandatory —
   *      AWS_IAM mode has no JWT claims to evaluate against).
   */
  readonly allowedGroups?: readonly string[];
  /**
   * Round 3 — per-developer entitlement: the set of stable JWT `sub` values
   * permitted to invoke this tool. Empty/undefined ⇒ no subject-scoping.
   * When present, the composed Cedar bundle adds one
   * `permit(principal == Developer::"<sub>", ...)` per subject, which the
   * wrapper evaluates by exact `sub` equality. May be combined with
   * `allowedGroups` (either a matching group OR a matching subject permits);
   * when either is present the workstream Gateway must run in CUSTOM_JWT mode
   * because AWS_IAM has no JWT claims to evaluate.
   */
  readonly allowedSubjects?: readonly string[];
}

/** JWT `sub` values: opaque, printable, bounded. */
const SUBJECT_REGEX = /^[A-Za-z0-9._:@|-]{1,255}$/;

/** Cognito group names: lower-case kebab/snake, max 128 chars (AWS limit). */
const COGNITO_GROUP_REGEX = /^[A-Za-z0-9_+=,.@-]{1,128}$/;

/** The authoritative catalogue. Append-only in v1; version bumps via PR. */
export const PLATFORM_TOOL_CATALOGUE: Readonly<Record<ToolId, ToolSpec>> = {
  // Two demo tools to start — platform-owned, approved.
  "tool-echo": {
    toolId: "tool-echo",
    targetArn:
      "arn:aws:lambda:${PLATFORM_REGION}:${PLATFORM_ACCOUNT_ID}:function:agenticai-d03-tool-echo:PROD",
    cedarPolicy:
      'permit(principal, action == Action::"InvokeTool", resource == Tool::"tool-echo");',
    ownerTeam: "platform-ai",
    costCentre: "platform",
    description: "Echoes the input string. Canonical health-check tool.",
    approvalStatus: "approved",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  "tool-ping": {
    toolId: "tool-ping",
    targetArn:
      "arn:aws:lambda:${PLATFORM_REGION}:${PLATFORM_ACCOUNT_ID}:function:agenticai-d03-tool-ping:PROD",
    cedarPolicy:
      'permit(principal, action == Action::"InvokeTool", resource == Tool::"tool-ping");',
    ownerTeam: "platform-ai",
    costCentre: "platform",
    description:
      "Returns pong + timestamp + caller principal. Observability probe.",
    approvalStatus: "approved",
    inputSchema: { type: "object", properties: {} },
  },
  // Strands Decider: a small decision model (choice / yes-no / rubric score with
  // calibrated confidence) on a private in-account SageMaker endpoint. The
  // Lambda and its `PROD` alias are owned by StrandsDeciderStack; it reads no
  // enterprise data, so any authenticated principal may call it.
  "tool-decider": {
    toolId: "tool-decider",
    targetArn:
      "arn:aws:lambda:${PLATFORM_REGION}:${PLATFORM_ACCOUNT_ID}:function:strands-decider-decide:PROD",
    externallyProvisioned: true,
    cedarPolicy:
      'permit(principal, action == Action::"InvokeTool", resource == Tool::"tool-decider");',
    ownerTeam: "platform-ai",
    costCentre: "platform",
    description:
      "Strands Decider: answers typed questions (choice, noul yes/no, rubric score) about a state with a calibrated confidence per answer.",
    approvalStatus: "approved",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "object",
          description: 'What the decision is about, as {"request": "<text>"}.',
          properties: { request: { type: "string" } },
          required: ["request"],
        },
        questions: {
          type: "object",
          description:
            "Map of name -> {type: choice|noul|score, instructions, criteria}. choice: criteria maps each option to a short string description (2-255 options); noul: criteria optional; score: criteria is 2-10 levels, lowest first.",
        },
      },
      required: ["state", "questions"],
    },
  },
  // COA (context-ontology-accelerator) agent tools. Each is its own Lambda with
  // a PROD alias, owned and deployed by COA's ServeToolStack (coa-dev-serve-tool),
  // generated from COA's tool-schemas.json. COA runs every call as one shared
  // identity (factory-agents); which agents reach a tool is decided here by
  // registry subscription.
  "tool-coa-query": {
    toolId: "tool-coa-query",
    targetArn:
      "arn:aws:lambda:${PLATFORM_REGION}:${PLATFORM_ACCOUNT_ID}:function:coa-dev-serve-tool-query:PROD",
    externallyProvisioned: true,
    cedarPolicy:
      'permit(principal, action == Action::"InvokeTool", resource == Tool::"tool-coa-query");',
    ownerTeam: "coa",
    costCentre: "coa",
    description:
      "COA: Answer a natural-language question against a COA namespace with tiered resolution (Tier 1 governed metrics, Tier 2 ontology-guided SQL, Tier 3 agentic fallback). Returns {result, requestId, sessionId}.",
    approvalStatus: "approved",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language question, e.g. 'What is monthly revenue by region?'",
        },
        namespaceId: {
          type: "string",
          description: "The COA namespace to query.",
        },
        execute: {
          type: "boolean",
          description:
            "False = translate only and return the generated query without running it.",
        },
        tierOverride: {
          type: "integer",
          description:
            "Pin resolution to tier 1, 2 or 3. Omit for automatic routing.",
        },
        mode: {
          type: "string",
          description:
            "'standard' (single shot) or 'deep-reasoning' (multi-step, slower).",
        },
        strategy: {
          type: "string",
          description:
            "Tier-2 engine: best, ontop, nl_to_sql, ontop_first, nl_to_sql_first or deep-reasoning.",
        },
        dimensions: {
          type: "array",
          description: "Dimension filters.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Dimension name." },
              value: { type: "string", description: "Dimension value." },
            },
            required: ["name", "value"],
          },
        },
        includeSupporting: {
          type: "boolean",
          description: "Include supporting document chunks (default true).",
        },
        maxResults: {
          type: "integer",
          description: "Maximum result rows (default 1000, max 10000).",
        },
        timeoutMs: {
          type: "integer",
          description: "Optional shorter budget in milliseconds.",
        },
      },
      required: ["query", "namespaceId"],
    },
  },
  "tool-coa-translate-sparql": {
    toolId: "tool-coa-translate-sparql",
    targetArn:
      "arn:aws:lambda:${PLATFORM_REGION}:${PLATFORM_ACCOUNT_ID}:function:coa-dev-serve-tool-translate-sparql:PROD",
    externallyProvisioned: true,
    cedarPolicy:
      'permit(principal, action == Action::"InvokeTool", resource == Tool::"tool-coa-translate-sparql");',
    ownerTeam: "coa",
    costCentre: "coa",
    description:
      "COA: Translate a natural-language question into SPARQL using the namespace's published ontology, without executing it. Returns {sparqlQuery, confidence, trace, ontologyVersion}.",
    approvalStatus: "approved",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language question to translate.",
        },
        namespaceId: {
          type: "string",
          description: "The COA namespace whose ontology is used.",
        },
      },
      required: ["query", "namespaceId"],
    },
  },
  "tool-coa-rag-retrieval": {
    toolId: "tool-coa-rag-retrieval",
    targetArn:
      "arn:aws:lambda:${PLATFORM_REGION}:${PLATFORM_ACCOUNT_ID}:function:coa-dev-serve-tool-rag-retrieval:PROD",
    externallyProvisioned: true,
    cedarPolicy:
      'permit(principal, action == Action::"InvokeTool", resource == Tool::"tool-coa-rag-retrieval");',
    ownerTeam: "coa",
    costCentre: "coa",
    description:
      "COA: Retrieve semantically similar document chunks from the namespace's knowledge base. Returns {chunks, trace, queryEmbeddingModel}.",
    approvalStatus: "approved",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language search query.",
        },
        namespaceId: {
          type: "string",
          description: "The COA namespace to search.",
        },
        topK: {
          type: "integer",
          description: "Maximum chunks to return (default 10, max 100).",
        },
        minScore: {
          type: "number",
          description: "Minimum similarity score, 0.0 to 1.0.",
        },
        sourceFilter: {
          type: "array",
          description: "Restrict to these source document ids.",
          items: { type: "string" },
        },
        entityFilter: {
          type: "array",
          description: "Restrict to chunks annotated with these entities.",
          items: { type: "string" },
        },
      },
      required: ["query", "namespaceId"],
    },
  },
  "tool-coa-graph-traversal": {
    toolId: "tool-coa-graph-traversal",
    targetArn:
      "arn:aws:lambda:${PLATFORM_REGION}:${PLATFORM_ACCOUNT_ID}:function:coa-dev-serve-tool-graph-traversal:PROD",
    externallyProvisioned: true,
    cedarPolicy:
      'permit(principal, action == Action::"InvokeTool", resource == Tool::"tool-coa-graph-traversal");',
    ownerTeam: "coa",
    costCentre: "coa",
    description:
      "COA: Traverse the namespace's semantic graph from an entity IRI. Returns {entities, relationships, trace}.",
    approvalStatus: "approved",
    inputSchema: {
      type: "object",
      properties: {
        startUri: {
          type: "string",
          description: "IRI of the entity to start from.",
        },
        namespaceId: {
          type: "string",
          description: "The COA namespace to traverse.",
        },
        maxDepth: {
          type: "integer",
          description: "Maximum depth (default 2, max 5).",
        },
        direction: {
          type: "string",
          description: "'outgoing', 'incoming' or 'both' (default).",
        },
        maxResults: {
          type: "integer",
          description: "Maximum entities (default 100, max 1000).",
        },
        relationshipFilter: {
          type: "array",
          description: "Restrict to these predicate IRIs.",
          items: { type: "string" },
        },
      },
      required: ["startUri", "namespaceId"],
    },
  },
  "tool-coa-list-metrics": {
    toolId: "tool-coa-list-metrics",
    targetArn:
      "arn:aws:lambda:${PLATFORM_REGION}:${PLATFORM_ACCOUNT_ID}:function:coa-dev-serve-tool-list-metrics:PROD",
    externallyProvisioned: true,
    cedarPolicy:
      'permit(principal, action == Action::"InvokeTool", resource == Tool::"tool-coa-list-metrics");',
    ownerTeam: "coa",
    costCentre: "coa",
    description:
      "COA: List the governed metric definitions in a COA namespace (name, description, dimensions, synonyms). Call this first to discover which metrics exist before querying. Read-only. Returns {metrics, nextToken?}.",
    approvalStatus: "approved",
    inputSchema: {
      type: "object",
      properties: {
        namespaceId: {
          type: "string",
          description: "The COA namespace to list metrics for.",
        },
        maxResults: {
          type: "integer",
          description: "Maximum metrics to return (default 100, max 1000).",
        },
        nextToken: {
          type: "string",
          description: "Continuation token from a previous response.",
        },
      },
      required: ["namespaceId"],
    },
  },
  "tool-coa-describe-schema": {
    toolId: "tool-coa-describe-schema",
    targetArn:
      "arn:aws:lambda:${PLATFORM_REGION}:${PLATFORM_ACCOUNT_ID}:function:coa-dev-serve-tool-describe-schema:PROD",
    externallyProvisioned: true,
    cedarPolicy:
      'permit(principal, action == Action::"InvokeTool", resource == Tool::"tool-coa-describe-schema");',
    ownerTeam: "coa",
    costCentre: "coa",
    description:
      "COA: Describe a COA namespace's ontology: classes, their properties, and the data-source tables behind them. Use it to learn what data exists and how entities relate before querying. Read-only. Returns {classes, ontologyVersion}.",
    approvalStatus: "approved",
    inputSchema: {
      type: "object",
      properties: {
        namespaceId: {
          type: "string",
          description: "The COA namespace to describe.",
        },
        maxResults: {
          type: "integer",
          description: "Maximum classes to return (default 100, max 500).",
        },
        includeProperties: {
          type: "boolean",
          description: "Include each class's properties (default true).",
        },
        classFilter: {
          type: "string",
          description: "Restrict to one class IRI or IRI prefix.",
        },
      },
      required: ["namespaceId"],
    },
  },
  "tool-coa-get-namespace": {
    toolId: "tool-coa-get-namespace",
    targetArn:
      "arn:aws:lambda:${PLATFORM_REGION}:${PLATFORM_ACCOUNT_ID}:function:coa-dev-serve-tool-get-namespace:PROD",
    externallyProvisioned: true,
    cedarPolicy:
      'permit(principal, action == Action::"InvokeTool", resource == Tool::"tool-coa-get-namespace");',
    ownerTeam: "coa",
    costCentre: "coa",
    description:
      "COA: Get a COA namespace's curated profile: display name, description and language, as authored by the namespace owner. Use it to frame the domain before querying. Read-only. Returns {namespace: {namespaceId, name, displayName, description, status, language}}.",
    approvalStatus: "approved",
    inputSchema: {
      type: "object",
      properties: {
        namespaceId: {
          type: "string",
          description: "The COA namespace to describe.",
        },
      },
      required: ["namespaceId"],
    },
  },
};

export const PLATFORM_TOOL_CATALOGUE_VERSION = "2";

// Pattern matchers:
const LAMBDA_ARN_WITH_ALIAS =
  /^arn:aws:lambda:(?:\$\{PLATFORM_REGION\}|[a-z0-9-]+):(?:\$\{PLATFORM_ACCOUNT_ID\}|\d{12}):function:[a-zA-Z0-9-_]+:[a-zA-Z0-9-_$]+$/;

/** Validate a ToolSpec at synth; throws with actionable message. */
export function validateToolSpec(spec: ToolSpec): void {
  if (!/^[a-z0-9-]{3,50}$/.test(spec.toolId)) {
    throw new Error(`ToolId must be kebab-case 3-50 chars: ${spec.toolId}`);
  }
  const toolType: ToolType = spec.toolType ?? "lambda";
  if (toolType === "lambda") {
    if (!LAMBDA_ARN_WITH_ALIAS.test(spec.targetArn)) {
      throw new Error(
        `Tool ${spec.toolId}: targetArn MUST end with a Lambda alias (Q5 pin-via-alias). Got: ${spec.targetArn}`,
      );
    }
    if (spec.a2aEndpointUrl) {
      throw new Error(
        `Tool ${spec.toolId}: a2aEndpointUrl is only valid when toolType='agent-a2a'`,
      );
    }
  } else if (toolType === "agent-a2a") {
    if (!spec.a2aEndpointUrl || !/^https:\/\//.test(spec.a2aEndpointUrl)) {
      throw new Error(
        `Tool ${spec.toolId}: agent-a2a tools require a2aEndpointUrl starting with https://`,
      );
    }
  } else {
    throw new Error(`Tool ${spec.toolId}: unsupported toolType ${toolType}`);
  }
  if (spec.targetAccountId && !/^\d{12}$/.test(spec.targetAccountId)) {
    throw new Error(`Tool ${spec.toolId}: targetAccountId must be 12 digits`);
  }
  if (!spec.cedarPolicy.includes("permit")) {
    throw new Error(`Tool ${spec.toolId}: cedarPolicy must contain permit()`);
  }
  if (
    !["approved", "experimental", "deprecated"].includes(spec.approvalStatus)
  ) {
    throw new Error(`Tool ${spec.toolId}: approvalStatus invalid`);
  }
  if (spec.allowedGroups !== undefined) {
    if (!Array.isArray(spec.allowedGroups) || spec.allowedGroups.length === 0) {
      throw new Error(
        `Tool ${spec.toolId}: allowedGroups, when present, must be a non-empty array of Cognito group names`,
      );
    }
    for (const g of spec.allowedGroups) {
      if (typeof g !== "string" || !COGNITO_GROUP_REGEX.test(g)) {
        throw new Error(
          `Tool ${spec.toolId}: allowedGroups entry '${g}' is not a valid Cognito group name`,
        );
      }
    }
  }
  if (spec.allowedSubjects !== undefined) {
    if (
      !Array.isArray(spec.allowedSubjects) ||
      spec.allowedSubjects.length === 0
    ) {
      throw new Error(
        `Tool ${spec.toolId}: allowedSubjects, when present, must be a non-empty array of JWT sub values`,
      );
    }
    for (const s of spec.allowedSubjects) {
      if (typeof s !== "string" || !SUBJECT_REGEX.test(s)) {
        throw new Error(
          `Tool ${spec.toolId}: allowedSubjects entry '${s}' is not a valid JWT sub value`,
        );
      }
    }
  }
}

/**
 * Resolve a subscription list into the catalogue subset, failing at synth
 * on any unknown id OR any deprecated tool being subscribed to fresh.
 * This is the synth-time gate from the three-layer governance model.
 */
export function resolveSubscribedTools(
  allowedToolIds: readonly ToolId[],
): ToolSpec[] {
  const unknown = allowedToolIds.filter(
    (id) => !(id in PLATFORM_TOOL_CATALOGUE),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown tool id(s) in allowedToolIds: ${unknown.join(", ")}. ` +
        `Known: ${Object.keys(PLATFORM_TOOL_CATALOGUE).join(", ")}. ` +
        `Add the tool to PLATFORM_TOOL_CATALOGUE first.`,
    );
  }
  const subset = allowedToolIds.map((id) => PLATFORM_TOOL_CATALOGUE[id]);
  const deprecated = subset.filter((s) => s.approvalStatus === "deprecated");
  if (deprecated.length > 0) {
    throw new Error(
      `Cannot subscribe to deprecated tool(s): ${deprecated.map((t) => t.toolId).join(", ")}. ` +
        `Remove from allowedToolIds or unmark as deprecated in PLATFORM_TOOL_CATALOGUE.`,
    );
  }
  return subset;
}

/**
 * Resolve a ToolSpec's targetArn into a concrete ARN by substituting
 * `${PLATFORM_REGION}` and `${PLATFORM_ACCOUNT_ID}`. Platform-owned tools use
 * the supplied account; cross-account tools use their explicit account id.
 */
export function resolveTargetArn(
  spec: ToolSpec,
  platformAccountId: string,
  platformRegion: string,
): string {
  const acct = spec.targetAccountId ?? platformAccountId;
  return spec.targetArn
    .replace("${PLATFORM_REGION}", platformRegion)
    .replace("${PLATFORM_ACCOUNT_ID}", acct);
}

/**
 * Compose the Cedar policy document for a subscription — union of
 * per-tool cedarPolicy strings plus a default deny. Per Q3.
 *
 * Phase Q (v0.6.0): when a ToolSpec carries `allowedGroups`, the composed
 * bundle replaces the tool's bare `permit` with one principal-bound permit
 * per Cognito group, so the Cedar evaluator can deny callers whose JWT
 * `cognito:groups` claim does not intersect the allow list. Tools without
 * allowedGroups keep their author-supplied cedarPolicy verbatim — this
 * preserves the v0.5.0 default of "any authenticated principal" for
 * back-compat.
 */
export function composeCedarPolicyDocument(
  subset: readonly ToolSpec[],
): string {
  const parts = subset.map((s) => {
    const hasGroups = !!(s.allowedGroups && s.allowedGroups.length > 0);
    const hasSubjects = !!(s.allowedSubjects && s.allowedSubjects.length > 0);
    if (hasGroups || hasSubjects) {
      const permits: string[] = [];
      if (hasGroups) {
        for (const g of s.allowedGroups!) {
          permits.push(
            `permit(principal in CognitoGroup::"${g}", action == Action::"InvokeTool", resource == Tool::"${s.toolId}");`,
          );
        }
      }
      if (hasSubjects) {
        for (const sub of s.allowedSubjects!) {
          permits.push(
            `permit(principal == Developer::"${sub}", action == Action::"InvokeTool", resource == Tool::"${s.toolId}");`,
          );
        }
      }
      const scopeNote = [
        hasGroups ? `groups [${s.allowedGroups!.join(", ")}]` : "",
        hasSubjects ? `subjects [${s.allowedSubjects!.length} sub(s)]` : "",
      ]
        .filter(Boolean)
        .join(" or ");
      return (
        `// Tool: ${s.toolId} (owner: ${s.ownerTeam})\n` +
        `// entitlement: principal-bound; only ${scopeNote} may invoke.\n` +
        permits.join("\n")
      );
    }
    return `// Tool: ${s.toolId} (owner: ${s.ownerTeam})\n${s.cedarPolicy.trim()}`;
  });
  // Default forbid — belt-and-braces; Gateway's authorizer is permit-only in practice
  parts.push(
    "// Default forbid — everything not explicitly permitted above\nforbid(principal, action, resource) unless { principal has allowed && resource has allowed };",
  );
  return parts.join("\n\n");
}

export type AgentCoreGatewayAuthorizerType = "AWS_IAM" | "CUSTOM_JWT";

export interface AgentCorePolicyEngineOptions {
  readonly authorizerType: AgentCoreGatewayAuthorizerType;
  readonly gatewayArn: string;
  readonly policyNamePrefix: string;
  readonly targetNames: Readonly<Record<string, string>>;
  /** Exact IAM role ARNs permitted to call an AWS_IAM Gateway. */
  readonly iamRoleArns?: readonly string[];
}

export interface AgentCorePolicyDefinition {
  readonly policyName: string;
  readonly toolId: string;
  readonly statement: string;
}

const AGENTCORE_POLICY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const AGENTCORE_TARGET_NAME = /^[0-9A-Za-z][0-9A-Za-z-]{0,99}$/;
const IAM_ROLE_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):iam::(\d{12}):role\/([A-Za-z0-9+=,.@_-]{1,64})$/;

function agentCorePolicyName(raw: string): string {
  let normalized = raw.replace(/[^A-Za-z0-9_]/g, "_");
  if (!/^[A-Za-z]/.test(normalized)) normalized = `P_${normalized}`;
  if (normalized.length > 48) {
    const digest = createHash("sha256")
      .update(raw, "utf8")
      .digest("hex")
      .slice(0, 8);
    normalized = `${normalized.slice(0, 39)}_${digest}`;
  }
  if (!AGENTCORE_POLICY_NAME.test(normalized)) {
    throw new Error(
      `AgentCore Policy name '${normalized}' must match ${AGENTCORE_POLICY_NAME.source}.`,
    );
  }
  return normalized;
}

function cedarString(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /["\\\r\n]/.test(value)
  ) {
    throw new Error(`${label} contains a character that is unsafe in Cedar.`);
  }
  return value;
}

function assumedRolePrincipal(roleArn: string): string {
  const match = IAM_ROLE_ARN.exec(roleArn);
  if (!match) {
    throw new Error(
      `PolicyEngine IAM principal '${roleArn}' must be an exact pathless IAM role ARN.`,
    );
  }
  const [, partition, accountId, roleName] = match;
  return `arn:${partition}:sts::${accountId}:assumed-role/${roleName}`;
}

function agentCorePermit(
  principal: string,
  action: string,
  gatewayArn: string,
  condition?: string,
): string {
  const statement = [
    "permit(",
    `  ${principal},`,
    `  action == AgentCore::Action::"${action}",`,
    `  resource == AgentCore::Gateway::"${gatewayArn}"`,
    ")",
  ];
  if (condition) {
    statement.push(`when { ${condition} };`);
  } else {
    statement[statement.length - 1] += ";";
  }
  return statement.join("\n");
}

/**
 * Compile one strict AgentCore Policy definition per subscribed tool.
 *
 * Policy in AgentCore uses a service schema that is intentionally different
 * from the legacy Lambda-wrapper grammar: principals are `IamEntity` or
 * `OAuthUser`, actions are `<TargetName>___<ToolName>`, and resources are an
 * exact Gateway ARN. Default deny is provided by the PolicyEngine itself, so
 * this compiler emits permits only and never a catch-all forbid that would
 * override them.
 */
export function composeAgentCorePolicyDefinitions(
  subset: readonly ToolSpec[],
  options: AgentCorePolicyEngineOptions,
): readonly AgentCorePolicyDefinition[] {
  if (subset.length === 0) {
    throw new Error("PolicyEngine requires at least one subscribed tool.");
  }
  const gatewayArn = cedarString(options.gatewayArn, "Gateway ARN");
  if (gatewayArn.includes("*")) {
    throw new Error("PolicyEngine Gateway ARN must not contain a wildcard.");
  }

  const configuredRoleArns = options.iamRoleArns ?? [];
  if (new Set(configuredRoleArns).size !== configuredRoleArns.length) {
    throw new Error("PolicyEngine IAM role ARNs must not contain duplicates.");
  }
  const roleArns = [...configuredRoleArns].sort();
  if (options.authorizerType === "AWS_IAM" && roleArns.length === 0) {
    throw new Error(
      "AWS_IAM PolicyEngine mode requires at least one exact IAM role ARN.",
    );
  }
  if (options.authorizerType === "CUSTOM_JWT" && roleArns.length > 0) {
    throw new Error(
      "CUSTOM_JWT PolicyEngine mode must not carry IAM role principals.",
    );
  }
  const iamPrincipals = roleArns.map(assumedRolePrincipal);

  return [...subset]
    .sort((left, right) => left.toolId.localeCompare(right.toolId))
    .map((tool) => {
      validateToolSpec(tool);
      const targetName = options.targetNames[tool.toolId];
      if (!targetName || !AGENTCORE_TARGET_NAME.test(targetName)) {
        throw new Error(
          `PolicyEngine target name for '${tool.toolId}' is absent or invalid.`,
        );
      }
      const action = cedarString(
        `${targetName}___${tool.toolId}`,
        `PolicyEngine action for '${tool.toolId}'`,
      );
      let statements: string[];

      if (options.authorizerType === "AWS_IAM") {
        if (tool.allowedGroups && tool.allowedGroups.length > 0) {
          throw new Error(
            `Tool '${tool.toolId}' has allowedGroups and therefore requires CUSTOM_JWT PolicyEngine mode.`,
          );
        }
        // An AgentCore Policy holds exactly ONE Cedar statement (a second
        // `permit` is rejected with "unexpected token `permit`"), so several
        // callers share one permit: the proven `principal ==` head for one
        // role, an `is IamEntity` head with an equality disjunction for more.
        statements =
          iamPrincipals.length === 1
            ? [
                agentCorePermit(
                  `principal == AgentCore::IamEntity::"${iamPrincipals[0]}"`,
                  action,
                  gatewayArn,
                ),
              ]
            : [
                agentCorePermit(
                  "principal is AgentCore::IamEntity",
                  action,
                  gatewayArn,
                  iamPrincipals
                    .map((principal) => `principal == AgentCore::IamEntity::"${principal}"`)
                    .join(" || "),
                ),
              ];
      } else if (tool.allowedGroups && tool.allowedGroups.length > 0) {
        const groupConditions = tool.allowedGroups.map((group) => {
          cedarString(group, `Cognito group for '${tool.toolId}'`);
          // AgentCore exposes this list-valued claim as JSON array text. The
          // isolated PolicyEngine testing proved quote-delimited element
          // matching; do not weaken this to a bare substring, which lets one
          // group name collide with another.
          const slash = String.fromCharCode(92);
          const quotedGroup = `${slash}"${group}${slash}"`;
          return (
            `(principal.hasTag("cognito:groups") && ` +
            `principal.getTag("cognito:groups") like "*${quotedGroup}*")`
          );
        });
        statements = [
          agentCorePermit(
            "principal is AgentCore::OAuthUser",
            action,
            gatewayArn,
            groupConditions.join(" || "),
          ),
        ];
      } else {
        statements = [
          agentCorePermit(
            "principal is AgentCore::OAuthUser",
            action,
            gatewayArn,
          ),
        ];
      }

      return {
        policyName: agentCorePolicyName(
          `${options.policyNamePrefix}_${tool.toolId}`,
        ),
        toolId: tool.toolId,
        statement: statements.join("\n\n"),
      };
    });
}
