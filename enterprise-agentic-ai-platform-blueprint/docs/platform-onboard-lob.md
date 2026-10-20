---
name: platform-onboard-lob
description: Platform-team runbook for LEVEL 2 — onboard a new LOB (tenant) onto the Enterprise Agentic AI Platform. Bootstrap the tenant's workload-account trust, stand up its per-tenant source bucket, and complete the CI-user handshake. This is ONCE PER LOB. The per-AGENT pipeline + registry record is a separate flow — see platform-onboard-agent. The org-wide control-plane setup is level 1 (PLATFORM_SETUP Part A).
---

# platform-onboard-lob — onboard a new LOB tenant (platform team, LEVEL 2)

Three onboarding levels, this is the middle one:
1. **Platform** (once per org) — gateway, registry, guardrails, pipelines. `PLATFORM_SETUP.md` Part A.
2. **LOB / tenant** (once per LOB) — **THIS SKILL**: account trust + source bucket + CI user.
3. **Agent** (once per agent, many per LOB) — per-agent pipeline + registry record: `platform-onboard-agent`.

The LOB owns its agents + execution; you (platform) own the shared tenant plumbing.
Authoritative source: `enterprise-agentic-ai-platform-blueprint/docs/PLATFORM_SETUP.md` Part B1–B4.

## Accounts
- **Platform (publisher):** `195698601974` — where the bucket/pipeline stacks are deployed.
- **Workload (consumer):** the LOB's account. MAY be shared by several LOBs
  (e.g. `172873868821` holds payors + providers); tenant-scoped names prevent collision.

## What is per-TENANT (this skill) vs per-AGENT (the other skill)
- **Per-TENANT — you set up ONCE per LOB here:** account trust (bootstrap), the
  source bucket `agenticai-pipeline-source-<tenant>`, and the LOB's single CI user.
  The tenant's VPC is also per-tenant but it is created on the LOB side (NetworkStack).
- **Per-AGENT — NOT here:** the `S3WorkloadPipelineStack`, its eval/registry roles, and
  the registry record are created once PER AGENT. See `platform-onboard-agent`.
  (Each agent also has its OWN AppStack + runtime on the LOB side — not one shared
  multi-agent stack — so per-agent eval gating works.)

## Prerequisite from the LOB
Get the LOB's **CI-runner USER ARN** — `arn:aws:iam::<acct>:user/agenticai-ci-runner-<tenant>`.
The LOB produces it with `create-iam-users.sh --tenant <tenant>` (access-key model:
a static-key IAM **user**, because GitLab CI here has no OIDC). You need it as the
**source-bucket policy principal**. One CI user serves ALL the tenant's agents.

## Steps

### 1. Confirm the workload account is bootstrapped to trust platform  (Step B1)
```
npx cdk bootstrap aws://<workload-account>/us-east-1 \
  --trust 195698601974 \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```
**ONE-TIME PER ACCOUNT, not per LOB.** If another LOB already onboarded into the same
workload account, `CDKToolkit` already trusts `195698601974` — verify, do NOT re-run.

### 2. Source bucket  (Step B2)
Create the per-tenant source bucket **now, at LOB-onboard**, with the dedicated
`LobSourceBucket` stack (`pipelines/lob-source-bucket-stack.ts`):
```ts
new LobSourceBucket(app, "aifactory-<tenant>-LobSourceBucket", {
  env: { account: "195698601974", region: deploymentRegion() },
  tenantId: "<tenant>",
  ciRunnerArn: "arn:aws:iam::<workload-acct>:user/agenticai-ci-runner-<tenant>",
});
```
It creates `agenticai-pipeline-source-<tenant>` (versioned, BLOCK_ALL, SSE) and grants
the CI **user** `s3:PutObject` on `/*` — so EVERY agent in the tenant can write to its
OWN prefix `<agentId>/workload-source.zip`. The bucket is genuinely tenant-owned here;
agents just add folders. Deploy once:
```
npx cdk deploy "aifactory-<tenant>-LobSourceBucket" --require-approval never
```

### 3. Hand off to the LOB  (Step B4)
Give back: the **bucket name** (`agenticai-pipeline-source-<tenant>`), the three
inference values (M2M secret ARN, gateway URL, model id), and confirm the account
bootstrap. The LOB then onboards each agent (level 3) and you register each (the
`platform-onboard-agent` skill).

## Traps
- **Account bootstrap is one-time per ACCOUNT, not per LOB.** Shared account = already
  trusted after the first tenant. Verify; don't re-bootstrap.
- **Access-key model:** the bucket-policy principal is the CI **user** ARN, NOT a role
  — GitLab has no OIDC here.
- **Don't hardcode LOB-specific ARNs** into the procedure — they live in the LOB's
  `cdk.context.json`; this runbook is the steps, not the values.
