# Calanthir — Invoking benefitsQanonprod from Loom: cross-account auth

## The situation
- **Runtime** `benefitsQanonprod-JgzQGK5bcJ` lives in **agentops-consumer** (172873868821, us-east-1).
  - `authorizerConfiguration: null` → **IAM/SigV4 auth only**, no JWT authorizer.
  - `networkMode: PUBLIC`. Hand-deployed (no CloudFormation tags → NOT CDK-managed, safe to patch via CLI).
  - Full ARN: `arn:aws:bedrock-agentcore:us-east-1:172873868821:runtime/benefitsQanonprod-JgzQGK5bcJ`
- **Loom backend** (`loom-backend-1`) invokes AWS as IAM user **`cli-user`** in **agentops-publisher** (195698601974)
  (ambient boto3 reading the mounted `loom-user` profile).
- So invoking is a **cross-account** call: publisher `cli-user` → consumer runtime.

## The error (before fix)
```
AccessDeniedException: User arn:aws:iam::195698601974:user/cli-user is not authorized to
perform bedrock-agentcore:InvokeAgentRuntime on <consumer runtime> because no resource-based
policy allows the action.
```
Two layers decide a cross-account invoke, and BOTH must allow:
1. Identity policy on `cli-user` (publisher) — allow `InvokeAgentRuntime` on the runtime ARN.
2. Resource policy on the runtime (consumer) — allow principal `cli-user`.  ← the gap the error named.

---

## OPTION A — resource policy (APPLIED 2026-10-09, demo path)
Added a least-privilege resource-based policy to the runtime in consumer:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowLoomBackendCliUserInvoke",
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::195698601974:user/cli-user" },
    "Action": "bedrock-agentcore:InvokeAgentRuntime",
    "Resource": "arn:aws:bedrock-agentcore:us-east-1:172873868821:runtime/benefitsQanonprod-JgzQGK5bcJ"
  }]
}
```
Applied with:
```
aws bedrock-agentcore-control put-resource-policy \
  --resource-arn <runtime ARN> --policy file://benefits-rbp.json \
  --profile agentops-consumer --region us-east-1
```
Reverse with `delete-resource-policy` on the same ARN.

### ⚠ CRITICAL QUIRK — the policy must be on the ENDPOINT ARN, not the runtime
`InvokeAgentRuntime` targets the **endpoint** sub-resource
`.../runtime/benefitsQanonprod-JgzQGK5bcJ/runtime-endpoint/DEFAULT`, NOT the bare runtime ARN.
And `put-resource-policy` requires the policy's `Resource` to EQUAL the `--resource-arn` exactly
(no wildcards, no multi-ARN — API rejects with "must contain exactly one resource ARN that matches").
So you need a resource policy attached to the **endpoint ARN**:
```
EP="arn:aws:bedrock-agentcore:us-east-1:172873868821:runtime/benefitsQanonprod-JgzQGK5bcJ/runtime-endpoint/DEFAULT"
aws bedrock-agentcore-control put-resource-policy --resource-arn "$EP" \
  --policy '<policy whose Resource == $EP>' --profile agentops-consumer --region us-east-1
```
The runtime-ARN policy alone does NOT authorize the endpoint invoke. (The runtime-level policy is
harmless to leave, but the endpoint-level one is the load-bearing one.)
`cli-user` identity side is already open — it has AdministratorAccess in publisher — so the ONLY gap
was this endpoint resource policy.

### Why A is the DEMO path, not production
Invokes as a **static shared IAM user** (`cli-user`) — no human identity, long-lived credential,
cross-account via a static principal. Fine to demo the mechanic; it is NOT the governed invoke posture
for a clinical/HIPAA agent (no per-user attribution). Talk-track line:
> "In the demo this invokes via a platform service credential to keep setup simple. The production
> pattern is a JWT authorizer on the runtime trusting the identity pool, so the end-user's identity
> flows through to invoke — the per-user attribution the governed path requires."

---

## OPTION B — JWT authorizer trusting the Loom pool (PRODUCTION path, TODO)
The identity-aware path: the user's own JWT is validated at invoke; no `cli-user`, no cross-account
IAM. This is the "we trust the Loom pool" model, done at the invoke (data) plane — distinct from the
deploy/govern plane's assume-role.

### Two changes

**1. Runtime side (consumer account) — add the authorizer.**
Mutable post-create (confirmed: `update-agent-runtime` accepts `--authorizer-configuration`; also
requires `--agent-runtime-artifact` so pass the CURRENT containerUri unchanged). No recreate needed.
```json
{
  "customJWTAuthorizer": {
    "discoveryUrl": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_NoErXe1QA/.well-known/openid-configuration",
    "allowedClients": ["3o0q6hdtfo1sphqq7jtqaspb3f"]
  }
}
```
- Pool `us-east-1_NoErXe1QA` = **loom-user-pool**, in agentops-publisher (195698601974).
- `allowedClients` (NOT `allowedAudience`) — our setup validates the **access token**'s `client_id`.
- Clients: `3o0q6hdtfo1sphqq7jtqaspb3f` = loom-user-pool-user-client (browser users);
  `752qo4e554h96dj9352p930llb` = loom-user-pool-m2m-client (add only if the backend uses M2M).
- Cross-account JWT trust is fine — the discovery URL is public; the runtime just validates tokens.

**⚠ Behavior change:** once the authorizer is on, the runtime stops accepting SigV4/`cli-user` and
accepts ONLY valid JWTs. Remove the Option-A resource policy once B works (or leave it; JWT auth
supersedes it for JWT callers). Any other IAM caller of this runtime breaks — check first.

**2. Loom backend side — invoke with the user's bearer JWT, not cli-user SigV4.**
The invoke code already has a `bearer_token` / `use_linked_token` path
(`frontend/src/hooks/useInvoke.ts`, `api/invocations.ts`). Need to confirm how the backend decides
SigV4-vs-bearer per agent and flip it so this agent passes the logged-in user's access token.

### Apply (when doing B)
```
aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id benefitsQanonprod-JgzQGK5bcJ \
  --agent-runtime-artifact '{"containerConfiguration":{"containerUri":"<CURRENT image from get-agent-runtime>"}}' \
  --authorizer-configuration file://authorizer.json \
  --role-arn arn:aws:iam::172873868821:role/AgenticAI-nonprod-calanthir-primary-exec \
  --profile agentops-consumer --region us-east-1
```
(Pull the exact current `containerUri` and `roleArn` from `get-agent-runtime` first so only the
authorizer changes.)
