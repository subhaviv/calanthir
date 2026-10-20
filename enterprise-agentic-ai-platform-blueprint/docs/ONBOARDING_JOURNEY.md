# Onboarding Journey — brand-new agent, new tenant, new platform

The single end-to-end map for the Enterprise Agentic AI Platform. It names **which of
the two teams** does each step and where control hands off. Every detailed procedure
referenced here lives in its own doc; this page is the map, not the manual.

## The two teams

| | Team | Owns | Runs in |
|---|---|---|---|
| 🏛️ | **Platform team** | the platform account, both pipelines, the source bucket, the GA registry | platform account (`195698601974`) |
| 🏢 | **LOB / product team** | the agent, its container image, its repo, merging to `main` | their workload account (e.g. `172873868821`) |

🤝 = a handoff between the teams.

---

## Phase 0 — 🏛️ Platform bootstrap  *(ONCE, ever — not per tenant, not per agent)*

Platform team, `PLATFORM_SETUP.md` **Part A**:

- **A1** Bootstrap the platform account
- **A2** Create + authorize the GitHub CodeStar connection
- **A3** Set platform context keys
- **A4** Bootstrap the platform pipeline

**Result:** the factory exists. Never repeated.

---

## Phase 1 — Onboard the TENANT (LOB)  🟦 *(ONCE per LOB)*

| # | Team | Action | Doc |
|---|------|--------|-----|
| 1 | 🏢 LOB | Bootstrap workload account to trust the platform; run `create-iam-users.sh` → CI **user** (access-key model, no OIDC) | `agentops-blueprint/docs/lob-onboard.md` |
| 2 | 🤝 | LOB → Platform: the **CI user ARN**, tenant id, workload account, region/AZs, cost centre | — |
| 3 | 🏛️ Platform | `cdk deploy aifactory-<tenant>-LobSourceBucket --context stage=pipeline --context agenticai/pipelineSelection=workload --context agenticai/defaultRegion=us-east-1` → the per-tenant source bucket, CI user granted `s3:PutObject` on `/*` | `PLATFORM_SETUP.md` B1–B2 |
| 4 | 🤝 | Platform → LOB: the **bucket name** + the 3 inference values (M2M secret ARN, gateway URL, model id) | `PLATFORM_SETUP.md` B4 |

**Result:** the tenant exists on the platform. Never repeated for this LOB.

---

## Phase 2 — Onboard the AGENT  🟩 *(ONCE per agent — repeat 5–11 for each new agent)*

| # | Team | Action | Doc |
|---|------|--------|-----|
| 5 | 🏢 LOB | Containerize the agent to the AgentCore HTTP contract (`/ping` + `/invocations`, ARM64); create its ECR repo; push the image | `agentops-blueprint/docs/lob-deploy-agent.md` §1–4 |
| 6 | 🤝 | LOB → Platform: the **agentId** | — |
| 7 | 🏛️ Platform | `cdk deploy aifactory-<tenant>-<agentId>-S3WorkloadPipelineStack --context stage=pipeline --context agenticai/pipelineSelection=workload --context agenticai/defaultRegion=us-east-1` — imports the tenant bucket, reads `sourceObjectKey: "<agentId>/workload-source.zip"`, has its OWN eval gate + registry/eval roles | `PLATFORM_SETUP.md` B3 |
| 8 | 🏢 LOB | Set CI vars (CI user keys, `PIPELINE_SOURCE_BUCKET`, `PIPELINE_SOURCE_KEY=<agentId>/workload-source.zip`); **merge to `main`** | `lob-deploy-agent.md` §5 |
| 9 | ⚙️ Pipeline | CI zips → uploads to the agent's S3 folder → Synth → Nonprod → **eval gate** → prod approval → Prod | automatic |
| 10 | 🤝 | LOB → Platform: the deployed **API Gateway endpoint** | — |
| 11 | 🏛️ Platform | Add the **GA registry record** → the agent becomes discoverable via loom and other consumers | `PLATFORM_SETUP.md` B5 |

**Result:** the agent is live and discoverable. **Repeat 5–11 for every new agent.** All
agents in the tenant share one VPC, one CI user, one source bucket; each agent gets its
OWN pipeline, OWN eval gate, OWN folder — so each is eval-gated independently.

---

## The ping-pong, in one line

```
🏛️ bootstrap (once)
   └─ 🏢 onboard LOB ─🤝→ 🏛️ bucket ─🤝→ 🏢
        └─ 🏢 build+push agent ─🤝→ 🏛️ pipeline ─🤝→ 🏢 merge → ⚙️ deploy ─🤝→ 🏛️ registry
             └─ repeat per agent ───────────────────────────────────────────────┘
```

The LOB always acts first (it owns the thing being shipped); the platform provisions the
governed infra and hands control back.

## Three cadences — do not confuse them

| Cadence | What | Who |
|---|---|---|
| **Once, ever** | platform bootstrap (Phase 0) | 🏛️ |
| **Once per LOB** | tenant onboarding (Phase 1) 🟦 | 🏢 + 🏛️ |
| **Once per agent** | agent onboarding (Phase 2) 🟩 — repeated | 🏢 + 🏛️ |

## Gotchas (learned the hard way)

- **Every `cdk` command needs `--context stage=pipeline`** (plus `agenticai/pipelineSelection=workload` and `agenticai/defaultRegion=us-east-1`), even when deploying ONE stack. Without it the app throws `Missing required CDK context 'stage'`. This is the #1 first-run failure.
- **Run every `cdk` command from the blueprint ROOT** (`enterprise-agentic-ai-platform-blueprint/`), not a `cdk/` subdirectory — else `No stacks match the name(s)`.
- **Strip `#` comment lines before pasting** into zsh — it reports `command not found: #`.
- **Deploy `LobSourceBucket` before the LOB's CI uploads.** The pipeline stack only *imports* the bucket by name, so it will deploy fine even if the bucket does not exist yet — but the CI `s3 cp` on merge will fail until the bucket is real. Order within the platform deploys does not matter; the bucket existing before the first merge does.
- **Run as the platform account** (`AWS_PROFILE=agentops-publisher` → 195698601974), not the workload account.
