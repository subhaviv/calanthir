# Benefits Q&A Agent — PPO Plan, Member Services

Extends the `agenticai-chatbot-agent` blueprint for PPO benefits Q&A, targeted at
**member service representatives** (MSRs) handling inbound member calls.

## What it does

- Answers PPO benefits questions grounded in the plan's knowledge base (deductibles, copays, coinsurance, formulary, network rules)
- Escalates automatically to a licensed specialist for coverage determinations, prior auth decisions, appeals, and grievances — MSRs cannot make these decisions
- Enforces guardrails on every inference call (R-BED-028)

## Corpus documents

| File | Contents |
|---|---|
| `summary-of-benefits-and-coverage.txt` | SBC: deductibles, OOP max, copays, coinsurance, prior auth requirements, exclusions, COB |
| `drug-formulary-2026.txt` | Tier 1–5 formulary, step therapy, quantity limits, specialty PA requirements |
| `network-and-referrals.txt` | PPO no-referral policy, network tiers, balance billing, emergency/urgent care |
| `eob-glossary.txt` | EOB field definitions, common MSR Q&A scripts, escalation triggers |

## Deployment

1. Upload corpus to the RAG bucket from the workload stack (`RagBucketName` output) under `ppo-benefits/`
2. Trigger a Bedrock KB sync (or wait for the scheduled sync)
3. Build the agent container and push to the ECR repo (`agenticai-nonprod-calanthir-primary`)
4. Pass `kb_id` (from the KB construct output) and `inference_profile_arn` (from `InferenceProfileArn` output) at runtime

## Running tests

```bash
python3 -m pytest blueprints/benefits-qa-agent/test_agent.py -v
```

## Escalation triggers

The agent auto-escalates (HITL) on: `coverage dispute`, `coverage denial`,
`prior authorization`, `prior auth`, `appeal`, `grievance`, `medical necessity`,
`experimental treatment`, `<escalate/>`, `HITL_REQUIRED`, `CANNOT_RESOLVE`.

Wire `hitl_hand_off` to the SQS queue: `agenticai-nonprod-calanthir-benefits-qa-escalations`
