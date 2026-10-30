---
name: platform-onboard-agent
description: Platform-team runbook for LEVEL 3 — register ONE agent onto an already-onboarded LOB tenant. Stand up the agent's own S3WorkloadPipelineStack (with its per-agent eval + registry-synth roles), then add its GA Registry record so it becomes discoverable. Run ONCE PER AGENT (many per LOB). Requires the LOB tenant to already be onboarded (platform-onboard-lob) — account trust + CI user in place.
---

# platform-onboard-agent — register one agent (platform team, LEVEL 3)

The per-AGENT flow. Runs once for each agent a LOB ships. Prerequisite: the LOB
tenant is already onboarded (`platform-onboard-lob`) — account trust + CI user exist.

Why per-agent: each agent is gated by its OWN evaluation. The
`S3WorkloadPipelineStack` resolves the registry record and runs the eval for a single
`agentId` (its soak alarm is `agenticai-online-eval-nonprod-<tenant>-<agentId>`), so
each agent needs its own pipeline. On the LOB side each agent likewise has its OWN
AppStack + runtime (NOT one shared multi-agent stack) — that is what makes per-agent
eval gating real: passing agent A's eval ships only agent A.

## 1. Add the agent's pipeline stack  (PLATFORM_SETUP Step B3)
Prerequisite: the tenant's `LobSourceBucket` already exists (created at LOB-onboard,
`platform-onboard-lob`). Every agent's pipeline IMPORTS it by name and reads its OWN
prefix. In `bin/agentic-ai-platform.ts`:
```ts
new S3WorkloadPipelineStack(app, "aifactory-<tenant>-<agentId>-S3WorkloadPipelineStack", {
  env: { account: "195698601974", region: deploymentRegion() },
  sourceBucketName: "agenticai-pipeline-source-<tenant>",   // import the tenant bucket
  sourceObjectKey: "<agentId>/workload-source.zip",          // this agent's OWN folder
  tenantId: "<tenant>", agentId: "<agentId>",
  applicationId: "aifactory-<tenant>", costCentre: "<tenant>",
  workloadNonprodEnv: { account: "<workload-acct>", region: "us-east-1" },
  workloadProdEnv:    { account: "<workload-acct>", region: "us-east-1" },
  workloadNonprodAvailabilityZones: ["us-east-1a","us-east-1b"],
  workloadProdAvailabilityZones:    ["us-east-1a","us-east-1b"],
  inferenceM2mSecretArn: ..., inferenceGatewayUrl: ..., inferenceModelId: ...,
  synthContext: sharedSynthContext,
});
```
- **The tenant bucket is shared; the FOLDER is per-agent.** Pass `sourceBucketName`
  (imports the existing bucket) + `sourceObjectKey: "<agentId>/workload-source.zip"`.
  No agent creates the bucket — `LobSourceBucket` did, once, at LOB-onboard.
- Pipeline stages: Synth → Nonprod → EvaluationGate → ProdApproval → Prod.

## 2. Bootstrap-deploy the pipeline stack (direct, once per agent)
Run as the platform account `195698601974`:
```
npx cdk deploy "aifactory-<tenant>-<agentId>-S3WorkloadPipelineStack" \
  --context stage=pipeline --context agenticai/pipelineSelection=workload \
  --require-approval never
```
After this, the LOB's merges to `main` flow through this agent's pipeline automatically.

## 3. Registry record — after the agent's first deploy  (Step B5)
The LOB gives you the agent's runtime ID / endpoint. Add an
`AWS::AgentRegistry::RegistryRecord` in `apps/platform-account/lib/registry-stack.ts`:
- `RecordType: "AGENT"` (NOT `CUSTOM` — a `CUSTOM` record shows as a tool, not an agent)
- `Descriptors.A2aAgentCard` with name/skills/url
- governance tags: application-id, tenant-id, cost-centre, owner-team
Wire the endpoint through `PlatformPipelineStack → PlatformDeploymentStage →
RegistryStack` via a context key; commit + push.
- **A new record is `DRAFT` until it is submitted.** In nonprod the registry approves on
  submit (`APPROVE_ALL`); agent records are not submitted by the stack, so submit yours
  (see PLATFORM_SETUP.md). Prod needs a curator. No APPROVED record = NOT discoverable.

## Traps
- **Runnable ≠ discoverable.** The LOB's deploy makes the agent invocable; it appears
  in the registry ONLY after this record deploys. Set the expectation.
- **Every agent imports the tenant bucket by name** (`sourceBucketName`) and uses its
  OWN folder (`sourceObjectKey: "<agentId>/workload-source.zip"`). No agent creates
  the bucket — `LobSourceBucket` did at LOB-onboard. Only the pipeline + eval/registry
  roles + the registry record are per-agent.
- **EvaluationGate may fail on first run** until the agent's evals are wired
  (golden datasets / the generated-agent eval path) — the bucket + pipeline still
  create; the gate just won't pass yet.
- **Record `RecordType` can't change in place.** To fix a wrong type, delete via Cloud
  Control API (`aws cloudcontrol delete-resource --type-name AWS::AgentRegistry::RegistryRecord`)
  then re-push.
- **The GA registry isn't readable with host AWS CLI 2.x** (`agent-registry` unknown
  service). Read it with a current botocore `agent-registry-control` client.
