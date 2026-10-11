# Workload Setup Guide

> **Audience: LOB (line of business) engineering team.**
> This guide covers everything you need to deploy agents on the platform — from setting up your repo to adding your first agent and subsequent agents. You do not need AWS CDK expertise beyond what is shown here, and you never touch the platform team's repo.

---

## How it works

Your LOB repo contains both your **agent code** (Python) and your **infrastructure** (CDK TypeScript). When you merge to `main`, your GitLab CI job zips the repo and uploads it to an S3 bucket. CodePipeline detects the new version and runs your workload pipeline — synth, deploy to nonprod, evaluation gate, approval, deploy to prod.

```
Your GitLab repo (main merge)
  → GitLab CI: zip + s3 cp
  → CodePipeline (agenticai-workload-s3-YOUR_TENANT-primary)
      → Synth (cdk synth your workload stacks)
      → Nonprod deploy
      → EvaluationGate
      → ProdApproval
      → Prod deploy
```

**You own:**
- `blueprints/` — agent Python, Dockerfile, requirements
- `apps/workload-account/` — CDK stacks for VPC, AgentCore runtimes, API Gateway
- `cdk.context.json` — image URIs, env config
- `.gitlab-ci.yml` — the S3 upload trigger

**The platform team owns:**
- The pipeline infrastructure (`S3WorkloadPipelineStack`) — you never touch it
- The inference gateway, GA registry, guardrails, Cognito M2M pool
- The registry record for your agent (they add it after your agent is live)

The platform team hands you:
- This repo template (already wired up)
- An S3 bucket name to upload to
- An ECR repo to push images to
- Three inference values for your `cdk.context.json`

---

## Prerequisites

- Access to your LOB's AWS workload account (`agentops-consumer` profile)
- Docker (for building and testing container images locally)
- Node.js 22+ and Python 3.12+ (for CDK synth and local tests)
- AWS CDK CLI: `npm install -g aws-cdk`
- Your GitLab CI runner configured with an IAM role that can `s3:PutObject` to the source bucket and `ecr:GetAuthorizationToken` / `ecr:BatchCheckLayerAvailability` / `ecr:PutImage` to the ECR repo

---

## Part 1 — First Agent

### Step 1 — Clone the Workload Blueprint Repo

The platform team maintains a ready-to-use workload blueprint at:

```
git@ssh.gitlab.aws.dev:subhaviv/agentops-blueprint.git
```

Clone it as the starting point for your LOB repo:

```bash
git clone git@ssh.gitlab.aws.dev:subhaviv/agentops-blueprint.git your-lob-repo
cd your-lob-repo
```

The repo contains:

```
apps/workload-account/lib/   — CDK stacks (VPC, runtimes, API Gateway)
blueprints/benefits-qa-agent/ — reference agent you can fork
bin/workload-app.ts           — CDK entrypoint (workload stage only)
cdk.context.json              — fill-in template (Step 2)
.gitlab-ci.yml                — S3 upload CI job (Step 7)
package.json / tsconfig.json  — TypeScript/CDK toolchain config
```

Install dependencies and verify the build:

```bash
npm ci
npx tsc --noEmit
```

If the compile fails, check with the platform team before proceeding.

### Step 2 — Fill in `cdk.context.json`

Open the `cdk.context.json` that came with the blueprint and replace the `FILL_IN_*` placeholders:

```json
{
  "agenticai/defaultRegion":        "us-east-1",
  "agenticai/workloadAccountId":    "YOUR_WORKLOAD_ACCOUNT_ID",
  "agenticai/vpcCidr":              "10.0.0.0/16",
  "agenticai/availabilityZones":    ["us-east-1a", "us-east-1b"],
  "agenticai/tenantId":             "YOUR_TENANT",
  "agenticai/agentId":              "primary",
  "agenticai/costCentre":           "YOUR_COST_CENTRE",
  "agenticai/envName":              "nonprod",
  "agenticai/deployWorkloadApp":    true,

  "agenticai/inferenceM2mSecretArn": "<from platform team>",
  "agenticai/inferenceGatewayUrl":   "<from platform team>",
  "agenticai/inferenceModelId":      "<from platform team>"
}
```

- `tenantId` + `agentId` combine into IAM role names — keep both short (combined ≤ 40 chars).
- The three `inference*` values come from the platform team's Step B4 handoff.

### Step 3 — Write Your Agent Blueprint

Create `blueprints/your-agent-name/` with three files.

#### `agent.py`

Critical rules:
- **Never read env vars at module level** — read them inside `_build_app()`. The runtime health check starts on container launch; module-level I/O prevents `/ping` from responding within 120 seconds.
- **Never call Bedrock directly** — all inference goes through the platform inference gateway via M2M OAuth.
- **Stamp every gateway request** with `baggage: session.id=<sid>` so the guardrail interceptor can correlate calls.
- **Never put secrets in plain env vars** — pass `INFERENCE_M2M_SECRET_ARN` and resolve from Secrets Manager inside `_build_app()`.

```python
import json, os, time, requests, logging, boto3
from typing import Any

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")


def _load_m2m_secret() -> dict:
    secret_arn = os.environ["INFERENCE_M2M_SECRET_ARN"]
    client = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    return json.loads(client.get_secret_value(SecretId=secret_arn)["SecretString"])


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
        # Claude models use the Anthropic Messages API, not OpenAI /v1/chat/completions
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
            "anthropic-version": "2023-06-01",  # required — gateway rejects without this
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

    m2m = _load_m2m_secret()
    gateway_url    = os.environ.get("INFERENCE_GATEWAY_URL") or m2m["gatewayUrl"]
    model_id       = os.environ["INFERENCE_MODEL_ID"]
    token_endpoint = m2m["tokenEndpoint"]
    client_id      = m2m["clientId"]
    client_secret  = m2m["clientSecret"]
    scope          = m2m["scope"]

    llm = GatewayLLMClient(gateway_url, model_id, token_endpoint, client_id, client_secret, scope)
    app = BedrockAgentCoreApp()

    @app.entrypoint
    async def handle(payload: dict[str, Any], context: Any):
        messages = payload.get("messages", [])
        if not messages:
            yield {"type": "RUN_FINISHED"}
            return
        response = llm.invoke(messages)
        yield {"type": "TEXT_MESSAGE_CONTENT", "delta": response}
        yield {"type": "RUN_FINISHED"}

    return app


if __name__ == "__main__":
    app = _build_app()
    app.run(host="0.0.0.0", port=8080)
```

#### `Dockerfile`

Use `python:3.13-slim` — not the Lambda base image (incompatible entrypoints).

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
requests
bedrock-agentcore
```

### Step 4 — Test the Container Locally

The ECR repo uses immutable tags — a pushed tag cannot be overwritten. Test locally before pushing to avoid burning tags on broken images.

```bash
# Build for the same architecture as AgentCore Runtime (arm64)
docker build --platform linux/arm64 -t your-agent-v1 blueprints/your-agent-name/

docker run --rm -d --name agent-test -p 8080:8080 \
  -e INFERENCE_GATEWAY_URL="<from platform team>" \
  -e INFERENCE_MODEL_ID="anthropic.claude-haiku-4-5" \
  -e INFERENCE_M2M_SECRET_ARN="<from platform team>" \
  -e AWS_REGION="us-east-1" \
  your-agent-v1

# /ping must return {"status":"Healthy"} within 120s
curl http://localhost:8080/ping

# /invocations must return a streaming response
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'

docker stop agent-test
```

Both endpoints must respond before you push. A container that can't answer `/ping` will fail the AgentCore health check and the runtime will never become `READY`.

### Step 5 — Push the Image to ECR

```bash
ECR="YOUR_WORKLOAD_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com"
aws ecr get-login-password --region us-east-1 --profile agentops-consumer | \
  docker login --username AWS --password-stdin $ECR

docker tag your-agent-v1:latest $ECR/agenticai-nonprod-YOUR_TENANT-primary:your-agent-v1
docker push $ECR/agenticai-nonprod-YOUR_TENANT-primary:your-agent-v1
```

### Step 6 — Wire the Runtime in CDK

In `cdk.context.json`, add the image URI:

```json
"agenticai/yourAgentImageUri": "YOUR_WORKLOAD_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/agenticai-nonprod-YOUR_TENANT-primary:your-agent-v1"
```

In `apps/workload-account/lib/workload-app-stack.ts`, add a `AgentCoreRuntimeProvisioner` for your agent:

```typescript
if (props.yourAgentImageUri) {
  const yourAgentRuntime = new AgentCoreRuntimeProvisioner(this, "YourAgentRuntime", {
    runtimeConstruct: this.app.runtime,
    agentRuntimeName: `yourAgent${props.envName}`,
    containerImageUri: props.yourAgentImageUri,
    description: "Your agent description",
    networkMode: "PUBLIC",
    environmentVariables: {
      INFERENCE_GATEWAY_URL:    props.inferenceGatewayUrl ?? "",
      INFERENCE_MODEL_ID:       props.inferenceModelId ?? "anthropic.claude-sonnet-5",
      INFERENCE_M2M_SECRET_ARN: props.inferenceM2mSecretArn ?? "",
      ENV_NAME:                 props.envName,
    },
  });

  // Grant cross-account read on the platform M2M secret
  if (props.inferenceM2mSecretArn) {
    this.app.runtime.executionRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["secretsmanager:GetSecretValue"],
      resources: [props.inferenceM2mSecretArn],
    }));
  }

  new CfnOutput(this, "YourAgentRuntimeId", {
    value: yourAgentRuntime.agentRuntimeId,
  });
}
```

Also add `yourAgentImageUri` to `WorkloadAppStackProps` and thread it through `WorkloadDeploymentStage` from `cdk.context.json`.

### Step 7 — Configure the CI Upload Job

The `.gitlab-ci.yml` in the blueprint already has the upload job. You only need to set two CI/CD variables in your GitLab project (**Settings → CI/CD → Variables**):

| Variable | Value |
|----------|-------|
| `AWS_ROLE_ARN` | IAM role ARN the platform team grants your runner (can `s3:PutObject` on the source bucket) |
| `PIPELINE_SOURCE_BUCKET` | `agenticai-pipeline-source-YOUR_TENANT` (platform team provides this) |

`PIPELINE_SOURCE_KEY` defaults to `workload-source.zip` in the job — leave it unless the platform team tells you otherwise.

### Step 8 — Deploy

Commit everything and merge to `main`:

```bash
git add blueprints/your-agent-name/ apps/ cdk.context.json .gitlab-ci.yml
git commit -m "feat(your-agent): initial deployment"
git push origin main
# merge to main via GitLab MR
```

The CI job runs, uploads to S3, and the pipeline fires:

```
agenticai-workload-s3-YOUR_TENANT-primary
  → Synth → Nonprod → EvaluationGate → ProdApproval → Prod
```

Watch it in the AWS Console: **CodePipeline → agenticai-workload-s3-YOUR_TENANT-primary** (platform account).

### Step 9 — Test the Deployed Agent

```bash
# Mint a Cognito token
TOKEN=$(aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id 3o0q6hdtfo1sphqq7jtqaspb3f \
  --auth-parameters USERNAME=YOUR_USER,PASSWORD=YOUR_PASSWORD \
  --region us-east-1 --profile agentops-consumer \
  --query 'AuthenticationResult.IdToken' --output text)

# Invoke the runtime directly
curl -s -X POST \
  "https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3AYOUR_WORKLOAD_ACCOUNT%3Aruntime%2FYOUR_RUNTIME_ID/invocations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"threadId":"test-001"}'
```

The runtime ID is in the `YourAgentRuntimeId` CloudFormation output of the Nonprod AppStack.

### Step 10 — Notify the Platform Team

Give the platform team your agent's API Gateway endpoint URL. They will add a registry record in the GA registry so your agent is discoverable via Loom and other consumers (see Step B5 in `PLATFORM_SETUP.md`).

---

## Part 2 — Adding a Subsequent Agent

Once your LOB is set up and the first pipeline run has succeeded, adding more agents is straightforward. Each agent gets its own `AgentCoreRuntimeProvisioner` in the same workload stack.

### Step 1 — Write the Blueprint

Create `blueprints/your-second-agent/` following Part 1 Step 3. The entrypoint contract (`/ping` + `/invocations`), M2M secret pattern, and `baggage` stamping are identical for every agent.

### Step 2 — Build and Test Locally

Follow Part 1 Steps 4. Use a new image tag for each build — ECR tags are immutable.

### Step 3 — Push the Image

Follow Part 1 Step 5 with a new tag (e.g. `your-second-agent-v1`).

### Step 4 — Wire the Runtime in CDK

Add a new image URI key to `cdk.context.json`:

```json
"agenticai/yourSecondAgentImageUri": "YOUR_WORKLOAD_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/agenticai-nonprod-YOUR_TENANT-primary:your-second-agent-v1"
```

Add a second `AgentCoreRuntimeProvisioner` block in `workload-app-stack.ts` following the same pattern as Step 6 in Part 1. Each runtime is independent — different image, different env vars, same execution role (or add a separate one if isolation is required).

### Step 5 — Deploy

Commit and merge to `main`. The same CI job uploads to S3 and the pipeline runs. Both runtimes (old and new) are deployed in the same Nonprod AppStack.

### Step 6 — Notify the Platform Team

Give the platform team the new agent's API Gateway endpoint so they can add a registry record.

---

## Reference

| Resource | Value |
|----------|-------|
| Calanthir workload account | `172873868821` |
| Calanthir ECR repo | `172873868821.dkr.ecr.us-east-1.amazonaws.com/agenticai-nonprod-calanthir-primary` |
| Workload pipeline | `agenticai-workload-s3-calanthir-primary` |
| External / Loom user pool | `us-east-1_NoErXe1QA` |
| External user pool client ID | `3o0q6hdtfo1sphqq7jtqaspb3f` |

---

## Common Pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| Runtime never becomes `READY` | Module-level env-var reads or I/O crash the container before `/ping` responds | Move all `os.environ` reads and I/O inside `_build_app()` |
| Runtime health check times out (120s) | Heavy imports at module level | Defer all initialization inside the entrypoint factory |
| Gateway returns 400 "does not support /v1/chat/completions" | Using OpenAI endpoint path for a Claude model | Use `/inference/v1/messages`, not `/v1/chat/completions` |
| Gateway returns 400 "anthropic_version: Field required" | Missing required header | Add `"anthropic-version": "2023-06-01"` to every request |
| Gateway returns 429 | Model ID uses CDK versioned format | Use short IDs like `anthropic.claude-haiku-4-5` |
| ECR push rejected | Tag already exists (immutable repo) | Use a new tag: `v1` → `v2` |
| Secrets Manager access denied at runtime | Execution role missing `secretsmanager:GetSecretValue` | Add the IAM grant in `workload-app-stack.ts` for each runtime |
| Pipeline does not trigger after merge | CI job not yet added, or S3 bucket name wrong | Verify `.gitlab-ci.yml` has the upload job and the bucket name matches what the platform team gave you |
