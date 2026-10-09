# Agent Onboarding Guide

This guide covers three parts:

- **[Part 0](#part-0--platform-setup-done-once-for-the-org)** — One-time org setup: deploy the shared platform account infrastructure (inference gateway, registry, guardrails, Cognito). Done once by the platform team before any LOB can onboard.
- **[Part 1](#part-1--onboarding-a-brand-new-lob-account)** — Per-LOB setup: bootstrap a new workload account and wire it into the platform pipeline.
- **[Part 2](#part-2--adding-a-subsequent-agent-to-an-existing-lob-account)** — Per-agent: add a new agent to an already-onboarded LOB account.

---

## Architecture Overview

The platform uses two AWS accounts per environment:

| Account | Profile | Owns |
|---------|---------|------|
| **Platform** (`195698601974`) | `agentops-publisher` | Inference gateway, GA registry, workload pipeline, guardrail interceptor, Cognito M2M pool |
| **Workload** (`172873868821`) | `agentops-consumer` | AgentCore runtimes, ECR, VPC, API Gateway (public-facing), application inference profiles |

The pipeline lives in the **platform account** and deploys cross-account into the workload account. All agent inference goes through the **platform inference gateway** — containers must never call Bedrock directly.

```
User → API Gateway (workload) → AgentCore Runtime (workload) → [M2M token] → Inference Gateway (platform) → Bedrock
                                                                              ↕
                                                                    Guardrail interceptor
```

---

## Part 0 — Platform Setup (done once for the org)

This is performed once by the platform team. All LOBs share these resources. Skip this part entirely if the platform account is already running.

### Prerequisites

- Platform AWS account provisioned and enrolled in your AWS Organization
- `agentops-publisher` profile configured locally pointing at the platform account
- CDK CLI available: `npx cdk`
- GitHub repo forked or copied from this blueprint

### Step 0.1 — Bootstrap the Platform Account

```bash
AWS_PROFILE=agentops-publisher npx cdk bootstrap aws://195698601974/us-east-1
```

### Step 0.2 — Set Platform Context Keys

In `cdk.context.json`, set the platform-account keys:

```json
{
  "agenticai/organizationId":           "o-XXXXXXXXXX",
  "agenticai/platformAccountId":        "195698601974",
  "agenticai/platformNonprodAccountId": "195698601974",
  "agenticai/registrySynthAccountId":   "195698601974",
  "agenticai/defaultRegion":            "us-east-1",
  "agenticai/inferenceModelRateLimits": [
    { "qualifiedModelId": "anthropic.claude-sonnet-5",  "requestsPerMinute": 1000, "tokensPerMinute": 5000000 },
    { "qualifiedModelId": "anthropic.claude-haiku-4-5", "requestsPerMinute": 2000, "tokensPerMinute": 10000000 },
    { "qualifiedModelId": "anthropic.claude-opus-4-8",  "requestsPerMinute": 200,  "tokensPerMinute": 1000000 },
    { "qualifiedModelId": "anthropic.claude-opus-5-5",  "requestsPerMinute": 200,  "tokensPerMinute": 1000000 },
    { "qualifiedModelId": "openai.gpt-5.5",             "requestsPerMinute": 1000, "tokensPerMinute": 5000000 },
    { "qualifiedModelId": "openai.gpt-6-sol",           "requestsPerMinute": 1000, "tokensPerMinute": 5000000 }
  ]
}
```

Model IDs must use the **short form** as returned by the gateway's `/inference/v1/models` endpoint, not the CDK versioned format (e.g. `anthropic.claude-haiku-4-5`, not `anthropic.claude-haiku-4-5-20251001-v1:0`). A zero-rate wildcard catch-all blocks every unlisted model ID, so getting this right matters.

### Step 0.3 — Deploy the Platform Stacks

```bash
# Nonprod platform (inference gateway, registry, guardrails, Cognito M2M)
AWS_PROFILE=agentops-publisher npx cdk deploy \
  "aifactory-*-Platform-*" \
  --context stage=platform \
  --context agenticai/envName=nonprod \
  --require-approval never

# Prod platform
AWS_PROFILE=agentops-publisher npx cdk deploy \
  "aifactory-*-Platform-*" \
  --context stage=platform \
  --context agenticai/envName=prod \
  --require-approval never
```

After this, the inference gateway, GA registry, guardrail interceptor, and Cognito M2M pool are live and shared by all LOBs. Note the gateway URL, token endpoint, M2M client ID, and OAuth scope from the stack outputs — every LOB agent container needs them as env vars.

---

## Part 1 — Onboarding a Brand-New LOB Account

### Prerequisites

- New AWS workload account created and enrolled in your AWS Organization
- Platform account (`195698601974`) bootstrapped and running (shared across all LOBs)
- CDK CLI available: `npx cdk`
- Two named AWS profiles configured locally:
  - `agentops-publisher` → platform account
  - `agentops-consumer` → new workload account

---

### Step 1 — CDK Bootstrap Both Accounts

The workload account must trust the platform account's CDK pipeline role so cross-account deployments work.

```bash
# Skip if the platform account is already bootstrapped
AWS_PROFILE=agentops-publisher npx cdk bootstrap \
  aws://195698601974/us-east-1

# Bootstrap the workload account, trusting the platform
AWS_PROFILE=agentops-consumer npx cdk bootstrap \
  aws://YOUR_WORKLOAD_ACCOUNT_ID/us-east-1 \
  --trust 195698601974 \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

---

### Step 2 — Fork the Blueprint Repository

Fork or copy this repository into a GitHub repo you control (e.g. `your-org/your-lob`). The pipeline will poll it for pushes.

---

### Step 3 — Create and Authorize a GitHub CodeStar Connection

```bash
# Run in the platform account
AWS_PROFILE=agentops-publisher aws codestar-connections create-connection \
  --provider-type GitHub \
  --connection-name your-lob-github \
  --query "ConnectionArn" --output text
```

Copy the returned ARN. Then go to **AWS Console → (platform account) → Developer Tools → Connections → your-lob-github → Update pending connection** and authorize it with GitHub. The connection must show `AVAILABLE` before the pipeline can pull source.

---

### Step 4 — Configure `cdk.context.json`

Open `cdk.context.json` at the repository root and add your LOB's values:

```json
{
  "agenticai/organizationId":               "o-XXXXXXXXXX",
  "agenticai/platformAccountId":            "195698601974",
  "agenticai/platformNonprodAccountId":     "195698601974",
  "agenticai/registrySynthAccountId":       "195698601974",
  "agenticai/workloadAccountIds":           ["YOUR_WORKLOAD_ACCOUNT_ID"],
  "agenticai/workloadNonprodAccountId":     "YOUR_WORKLOAD_ACCOUNT_ID",
  "agenticai/workloadProdAccountId":        "YOUR_WORKLOAD_ACCOUNT_ID",
  "agenticai/envName":                      "nonprod",
  "agenticai/defaultRegion":                "us-east-1",
  "agenticai/applicationId":               "aifactory-YOUR_TENANT",
  "agenticai/tenantId":                     "YOUR_TENANT",
  "agenticai/agentId":                      "primary",
  "agenticai/costCentre":                   "YOUR_COST_CENTRE",
  "agenticai/pipelineRoleArn":             "arn:aws:iam::195698601974:role/Admin",
  "agenticai/pipelineSelection":            "workload",
  "agenticai/githubRepo":                   "YOUR_ORG/YOUR_REPO",
  "agenticai/githubBranch":                 "main",
  "agenticai/githubConnectionArn":          "arn:aws:codestar-connections:us-east-1:195698601974:connection/YOUR_CONNECTION_ID",
  "agenticai/workloadNonprodAvailabilityZones": ["us-east-1a", "us-east-1b"],
  "agenticai/workloadProdAvailabilityZones":    ["us-east-1a", "us-east-1b"],
  "agenticai/externalUserPoolId":           "us-east-1_NoErXe1QA",
  "agenticai/externalUserPoolClientId":     "3o0q6hdtfo1sphqq7jtqaspb3f",
  "agenticai/externalUserPoolRegion":       "us-east-1",
  "agenticai/inferenceModelRateLimits": [
    { "qualifiedModelId": "anthropic.claude-sonnet-5",  "requestsPerMinute": 1000, "tokensPerMinute": 5000000 },
    { "qualifiedModelId": "anthropic.claude-haiku-4-5", "requestsPerMinute": 2000, "tokensPerMinute": 10000000 },
    { "qualifiedModelId": "anthropic.claude-opus-4-8",  "requestsPerMinute": 200,  "tokensPerMinute": 1000000 },
    { "qualifiedModelId": "anthropic.claude-opus-5-5",  "requestsPerMinute": 200,  "tokensPerMinute": 1000000 },
    { "qualifiedModelId": "openai.gpt-5.5",             "requestsPerMinute": 1000, "tokensPerMinute": 5000000 },
    { "qualifiedModelId": "openai.gpt-6-sol",           "requestsPerMinute": 1000, "tokensPerMinute": 5000000 }
  ]
}
```

**Notes:**
- `tenantId` + `agentId` combine into IAM role names — keep both short (total ≤ ~40 chars) to stay under the 64-char IAM limit.
- `workloadProdAccountId` can be the same as `workloadNonprodAccountId` if you have a single account.
- Model IDs in `inferenceModelRateLimits` must use the **short form** returned by the gateway's `/inference/v1/models` endpoint, not the CDK versioned format. To verify:

```bash
TOKEN=$(curl -s -X POST "https://agenticai-inference-nonprod-195698601974-us-east-1.auth.us-east-1.amazoncognito.com/oauth2/token" \
  -d "grant_type=client_credentials&client_id=6dfc8kjvkmej8fvimdcpdqs5h1&client_secret=YOUR_SECRET&scope=agenticai-inference-nonprod-api/invoke" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

curl -s "https://agenticai-inference-nonprod-wainu7pcof.gateway.bedrock-agentcore.us-east-1.amazonaws.com/inference/v1/models" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

---

### Step 5 — Deploy the Workload Pipeline (platform account)

The pipeline lives in the platform account and self-mutates on every push to `githubBranch`.

```bash
AWS_PROFILE=agentops-publisher npx cdk deploy \
  "aifactory-YOUR_TENANT-WorkloadPipelineStack" \
  --context stage=pipeline \
  --require-approval never
```

This creates CodePipeline `agenticai-workload-YOUR_TENANT-primary` in the platform account. Its stages are:

```
Source (GitHub) → Synth → UpdatePipeline (self-mutate) → Assets
  → Nonprod deploy → EvaluationGate → ProdApproval → CanaryDeploy → Prod
```

From this point on, **all workload infrastructure changes must go through this pipeline** — commit and push, never deploy directly to the workload account.

---

### Step 7 — Write Your First Agent Blueprint

Create `blueprints/your-agent-name/` with the following files.

#### `agent.py` — AgentCore Runtime entrypoint

Critical rules:
- Never read env vars at module level. Read them inside `_build_app()`. The runtime's 120-second health check starts on container launch, and module-level I/O can prevent `/ping` from responding in time.
- Never call Bedrock directly. All inference must go through the platform inference gateway using an M2M OAuth token.
- Stamp every gateway request with `baggage: session.id=<sid>` so the guardrail interceptor can correlate calls.

```python
import os, time, requests, logging
from typing import Any

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")


class _TokenCache:
    def __init__(self):
        self._token = ""
        self._expires_at = 0.0

    def get(self, token_endpoint, client_id, client_secret, scope):
        if time.monotonic() < self._expires_at - 30:
            return self._token
        resp = requests.post(token_endpoint, data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": scope,
        }, timeout=10)
        resp.raise_for_status()
        body = resp.json()
        self._token = body["access_token"]
        self._expires_at = time.monotonic() + body.get("expires_in", 3600)
        return self._token


_token_cache = _TokenCache()


class GatewayLLMClient:
    def __init__(self, gateway_url, model_id, token_endpoint, client_id, client_secret, scope):
        # Claude models on the gateway use Anthropic Messages API, not OpenAI /v1/chat/completions
        self._url = gateway_url.rstrip("/") + "/inference/v1/messages"
        self._model = model_id
        self._creds = (token_endpoint, client_id, client_secret, scope)

    def invoke(self, messages, **kwargs):
        system = next((m["content"] for m in messages if m["role"] == "system"), "")
        chat = [m for m in messages if m["role"] != "system"]
        body = {"model": self._model, "max_tokens": 4096, "messages": chat}
        if system:
            body["system"] = system

        headers = {
            "Authorization": f"Bearer {_token_cache.get(*self._creds)}",
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",  # required — gateway rejects requests without this
        }
        try:
            from bedrock_agentcore import BedrockAgentCoreContext
            sid = BedrockAgentCoreContext.get_session_id()
            if sid:
                headers["baggage"] = f"session.id={sid}"
        except Exception:
            pass

        resp = requests.post(self._url, headers=headers, json=body, timeout=120)
        if not resp.ok:
            log.error("Gateway error %s: %s", resp.status_code, resp.text)
            resp.raise_for_status()
        return resp.json()["content"][0]["text"]


def _build_app():
    from bedrock_agentcore import BedrockAgentCoreApp

    gateway_url    = os.environ["INFERENCE_GATEWAY_URL"]
    model_id       = os.environ["INFERENCE_MODEL_ID"]
    token_endpoint = os.environ["COGNITO_TOKEN_ENDPOINT"]
    client_id      = os.environ["COGNITO_CLIENT_ID"]
    client_secret  = os.environ["COGNITO_CLIENT_SECRET"]
    scope          = os.environ["COGNITO_SCOPE"]

    llm = GatewayLLMClient(gateway_url, model_id, token_endpoint, client_id, client_secret, scope)
    app = BedrockAgentCoreApp()

    @app.entrypoint
    def handle(payload: dict[str, Any], context: Any) -> dict[str, Any]:
        messages = payload.get("messages", [])
        if not messages:
            return {"response": "Hello! How can I help?"}
        return {"response": llm.invoke(messages)}

    return app


if __name__ == "__main__":
    app = _build_app()
    app.run(host="0.0.0.0", port=8080)
```

#### `Dockerfile`

Use `python:3.13-slim`, not the Lambda base image — the Lambda base has Lambda-specific entrypoints incompatible with the AgentCore HTTP server mode.

```dockerfile
FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && pip check
COPY agent.py .
USER 10001
EXPOSE 8080
ENTRYPOINT ["python", "-u", "agent.py"]
```

#### `requirements.txt`

```
boto3
botocore
strands-agents
bedrock-agentcore
```

---

### Step 8 — Test the Container Locally Before Pushing

The platform ECR repo uses immutable tags. If a tag is pushed once, it cannot be overwritten — use a new tag every build (e.g. `v1`, `v2`, ...). Test locally first to avoid wasting tags on broken images.

```bash
# Build for the same architecture as AgentCore Runtime (arm64)
docker build --platform linux/arm64 -t your-agent-v1 blueprints/your-agent-name/

docker run --rm -d --name agent-test -p 8080:8080 \
  -e INFERENCE_GATEWAY_URL="https://agenticai-inference-nonprod-wainu7pcof.gateway.bedrock-agentcore.us-east-1.amazonaws.com" \
  -e INFERENCE_MODEL_ID="anthropic.claude-haiku-4-5" \
  -e COGNITO_TOKEN_ENDPOINT="https://agenticai-inference-nonprod-195698601974-us-east-1.auth.us-east-1.amazoncognito.com/oauth2/token" \
  -e COGNITO_CLIENT_ID="6dfc8kjvkmej8fvimdcpdqs5h1" \
  -e COGNITO_CLIENT_SECRET="YOUR_SECRET" \
  -e COGNITO_SCOPE="agenticai-inference-nonprod-api/invoke" \
  -e GUARDRAIL_IDENTIFIER="YOUR_GUARDRAIL_ID" \
  -e GUARDRAIL_VERSION="DRAFT" \
  your-agent-v1

# /ping must return {"status":"Healthy"} — this is what the 120s health check calls
curl http://localhost:8080/ping

# /invocations must return {"response":"..."}
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'

docker stop agent-test
```

Both endpoints must respond correctly before you push. A container that can't answer `/ping` in 120 seconds will fail the AgentCore Runtime health check and the runtime will never become `READY`.

---

### Step 9 — Push to ECR and Trigger the Pipeline

```bash
ECR="YOUR_WORKLOAD_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com"
AWS_PROFILE=agentops-consumer aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin $ECR

docker tag your-agent-v1:latest $ECR/agenticai-nonprod-YOUR_TENANT-primary:your-agent-v1
docker push $ECR/agenticai-nonprod-YOUR_TENANT-primary:your-agent-v1
```

Commit the image tag and CDK changes to `main`. The pipeline triggers automatically.

```bash
git add blueprints/your-agent-name/ cdk.context.json
git commit -m "feat(your-agent): add initial agent blueprint"
git push origin main
```

Watch the pipeline in the platform account Console: **CodePipeline → agenticai-workload-YOUR_TENANT-primary**.

---

### Step 10 — Register the Agent in the GA Registry

After the workload stack deploys, capture its API Gateway output URL and the Runtime ARN, then add them to `cdk.context.json`:

```json
"agenticai/yourAgentA2aEndpointUrl": "https://YOUR_APIGW_ID.execute-api.us-east-1.amazonaws.com",
"agenticai/yourAgentRuntimeArn":     "arn:aws:bedrock-agentcore:us-east-1:YOUR_WORKLOAD_ACCOUNT:agent-runtime/YOUR_RUNTIME_ID"
```

Add a record to `apps/platform-account/lib/registry-stack.ts`:

```typescript
if (props.yourAgentA2aEndpointUrl) {
  const a2aCard = {
    protocolVersion: "0.3",
    name: "your-agent",
    description: "One-sentence description under 100 characters.",   // hard limit: 100 chars
    version: "1.0",
    url: props.yourAgentA2aEndpointUrl,
    capabilities: { streaming: true },
    skills: [
      {
        id: "your-skill",
        name: "Your Skill",
        description: "What the skill does.",
        tags: ["your-domain"],
      },
    ],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };

  const record = new CfnResource(this, "YourAgentRecord", {
    type: "AWS::AgentRegistry::RegistryRecord",
    properties: {
      RegistryId: this.gaRegistry.registryId,
      Name: "your-agent",
      DisplayName: "Your Agent Display Name",
      Description: "Full description for the registry UI.",
      RecordType: "AGENT",       // must be AGENT — CUSTOM renders as a tool in Loom
      RecordVersion: "1.0.0",
      Descriptors: {
        A2aAgentCard: {
          Data: JSON.stringify(a2aCard),
          DataSchemaVersion: "0.3",
        },
      },
      Tags: [
        { Key: "application-id", Value: props.applicationId },
        { Key: "agent-id",       Value: "your-agent" },
        { Key: "tenant-id",      Value: props.tenantId },
        { Key: "cost-centre",    Value: props.costCentre },
        { Key: "environment",    Value: props.envName },
        { Key: "owner-team",     Value: "your-team" },
      ],
    },
  });
  record.addDependsOn(this.gaRegistry.registry);
  record.applyRemovalPolicy(RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE);
}
```

Add the prop to `RegistryStackProps`:

```typescript
readonly yourAgentA2aEndpointUrl?: string;
```

Deploy directly from the platform account (registry changes don't need the workload pipeline):

```bash
AWS_PROFILE=agentops-publisher npx cdk deploy \
  "aifactory-YOUR_TENANT-Platform-RegistryStack" \
  --context stage=platform \
  --context agenticai/envName=nonprod \
  --require-approval never
```

In nonprod, the registry auto-approves records (`APPROVE_ALL`). In prod, a platform curator must approve the record in the Console before it becomes discoverable in Loom.

> **If you need to change `RecordType` on an existing record** (e.g. `CUSTOM` → `AGENT`), CloudFormation cannot update it in-place. Delete the old record first:
> ```bash
> aws cloudcontrol delete-resource \
>   --type-name "AWS::AgentRegistry::RegistryRecord" \
>   --identifier "RECORD_ARN" \
>   --profile agentops-publisher
> ```
> Then redeploy to create the new record.

---

## Part 2 — Adding a Subsequent Agent to an Existing LOB Account

Once the LOB account is bootstrapped and the pipeline is running, adding a new agent requires four things: a blueprint, a CDK runtime construct, a registry record, and a push.

### Step 1 — Add the Agent Blueprint

Create `blueprints/your-new-agent/` following the structure from Part 1 Step 7. The entrypoint contract (`/ping` + `/invocations`), M2M gateway pattern, and `baggage` stamping are identical for every agent.

Agent-specific parts:
- System prompt and business logic
- The `INFERENCE_MODEL_ID` env var (pick from the approved list in `inferenceModelRateLimits`)
- Any domain-specific env vars (`PLAN_YEAR`, `ENV_NAME`, etc.)

---

### Step 2 — Wire the AgentCore Runtime in the Workload Stack

In `apps/workload-account/lib/workload-app-stack.ts`, add a new `AgentCoreRuntimeProvisioner`:

```typescript
import { AgentCoreRuntimeProvisioner } from "@agenticai/agentcore-runtime";

const myAgentRuntime = new AgentCoreRuntimeProvisioner(this, "MyAgentRuntime", {
  agentRuntimeName: `myAgent${props.envName}`,
  containerUri: `${ecrRepo.repositoryUri}:my-agent-v1`,
  executionRoleArn: agentExecRole.roleArn,
  networkMode: "PUBLIC",
  environmentVariables: {
    INFERENCE_GATEWAY_URL:  inferenceGatewayUrl,
    INFERENCE_MODEL_ID:     "anthropic.claude-haiku-4-5",
    COGNITO_TOKEN_ENDPOINT: cognitoTokenEndpoint,
    COGNITO_CLIENT_ID:      cognitoClientId,
    COGNITO_CLIENT_SECRET:  cognitoClientSecret,
    COGNITO_SCOPE:          cognitoScope,
    GUARDRAIL_IDENTIFIER:   guardrailIdentifier,
    GUARDRAIL_VERSION:      "DRAFT",
    ENV_NAME:               props.envName,
  },
});

new CfnOutput(this, "MyAgentRuntimeArn", {
  value: myAgentRuntime.agentRuntimeArn,
});
```

The `AgentCoreRuntimeProvisioner` uses `bedrock-agentcore:*` IAM actions (not `bedrock-agentcore-control:*`) and `PhysicalResourceIdReference` on the delete handler — both are in the current codebase.

For secrets like `COGNITO_CLIENT_SECRET`, store in Secrets Manager and reference via `secretsFrom` in the provisioner for prod environments.

---

### Step 3 — Add the Registry Record

Follow Part 1 Step 10. Each agent gets its own `RecordType: "AGENT"` record. Add to `cdk.context.json`:

```json
"agenticai/myNewAgentA2aEndpointUrl": "https://YOUR_APIGW_ID.execute-api.us-east-1.amazonaws.com",
"agenticai/myNewAgentRuntimeArn":     "arn:aws:bedrock-agentcore:us-east-1:WORKLOAD_ACCT:agent-runtime/RUNTIME_ID"
```

---

### Step 4 — Test Locally, Push, and Let the Pipeline Deploy

```bash
# 1. Build and test locally (mandatory — ECR tags are immutable)
docker build --platform linux/arm64 -t my-agent-v1 blueprints/your-new-agent/
# ... run /ping and /invocations tests as in Part 1 Step 8 ...

# 2. Push the image
ECR="WORKLOAD_ACCOUNT.dkr.ecr.us-east-1.amazonaws.com"
AWS_PROFILE=agentops-consumer aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin $ECR
docker tag my-agent-v1 $ECR/agenticai-nonprod-YOUR_TENANT-primary:my-agent-v1
docker push $ECR/agenticai-nonprod-YOUR_TENANT-primary:my-agent-v1

# 3. Commit everything and push to trigger the pipeline
git add blueprints/your-new-agent/ apps/ cdk.context.json
git commit -m "feat(your-new-agent): add My Agent runtime and registry record"
git push origin main
```

The pipeline picks up the commit, runs CDK synth and conformance tests, deploys to Nonprod, runs the evaluation gate, waits for manual approval, then deploys to Prod. The agent appears in Loom as an invokable agent once the registry record is live and approved.

---

## Reference: Key Platform ARNs and IDs

| Resource | Value |
|----------|-------|
| Platform account | `195698601974` |
| Calanthir workload account | `172873868821` |
| Inference gateway ID | `agenticai-inference-nonprod-wainu7pcof` |
| Gateway base URL | `https://agenticai-inference-nonprod-wainu7pcof.gateway.bedrock-agentcore.us-east-1.amazonaws.com` |
| Gateway messages endpoint | `<base>/inference/v1/messages` |
| Token endpoint | `https://agenticai-inference-nonprod-195698601974-us-east-1.auth.us-east-1.amazoncognito.com/oauth2/token` |
| M2M client ID | `6dfc8kjvkmej8fvimdcpdqs5h1` |
| OAuth scope | `agenticai-inference-nonprod-api/invoke` |
| External / Loom user pool | `us-east-1_NoErXe1QA` |
| GA Registry ID | `thx22kgS5M7oTMy7` |
| Benefits QA runtime ARN | `arn:aws:bedrock-agentcore:us-east-1:172873868821:runtime/benefitsQanonprod-JgzQGK5bcJ` |
| Benefits QA registry record | `mMkwoKJhspgT` |
| Calanthir ECR repo | `172873868821.dkr.ecr.us-east-1.amazonaws.com/agenticai-nonprod-calanthir-primary` |
| Calanthir API Gateway | `https://eoku9zqkg4.execute-api.us-east-1.amazonaws.com` |

## Common Pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| Runtime never becomes `READY` | Module-level env-var reads crash container before `/ping` can respond | Move all `os.environ` reads inside `_build_app()` |
| Runtime health check times out (120s) | Container imports heavy dependencies or does I/O at module level | Defer all initialization to inside the entrypoint factory |
| Gateway returns 400 "does not support /v1/chat/completions" | Using OpenAI endpoint for a Claude model | Claude models use `/inference/v1/messages`, not `/v1/chat/completions` |
| Gateway returns 400 "anthropic_version: Field required" | Missing header | Add `"anthropic-version": "2023-06-01"` to every gateway request |
| Gateway returns 429 from `models-nonprod` | Model ID in context uses CDK versioned format | Use short IDs like `anthropic.claude-haiku-4-5`, verify via `/inference/v1/models` |
| ECR push rejected | Tag already exists (immutable repo) | Increment the tag version: `v1` → `v2` |
| Agent appears as a tool in Loom, not an agent | `RecordType: "CUSTOM"` | Change to `RecordType: "AGENT"` with `Descriptors.A2aAgentCard`; delete old record first |
| CFN 409 on registry update | Cannot update `RecordType` in-place | Delete old record via Cloud Control API, then redeploy |
| CodeBuild fails with `git ls-files` error | CodeBuild checkout has no `.git` directory | Conformance tests guard this with `try/catch` around `git rev-parse` — ensure patch is present |
| Pipeline synth fails with `TypeError: crCfn.addPropertyOverride is not a function` | Wrong CDK API on `AwsCustomResource` result | Use `PhysicalResourceIdReference` in the `onDelete` handler, not `addPropertyOverride` |
