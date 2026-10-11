# Platform Setup Guide

> **Audience: platform team.**
> This guide is performed once per AWS Organization. It deploys the shared infrastructure that all LOBs consume — inference gateway, GA registry, guardrails, Cognito M2M pool, and the pipelines that deploy workload accounts.

---

## Architecture Overview

```
User → API Gateway (workload) → AgentCore Runtime (workload)
         → [M2M token] → Inference Gateway (platform) → Bedrock
                                    ↕
                          Guardrail interceptor
```

| Account | Profile | Owns |
|---------|---------|------|
| **Platform** (`195698601974`) | `agentops-publisher` | Inference gateway, GA registry, guardrail interceptor, Cognito M2M pool, all pipelines |
| **Workload** (per LOB) | `agentops-consumer` | AgentCore runtimes, ECR, VPC, API Gateway |

### Two pipelines

| Pipeline | Stack | Deploys |
|----------|-------|---------|
| `agenticai-platform-pipeline` | `PlatformPipelineStack` | Platform account stacks (guardrails, registry, inference gateway) |
| `agenticai-workload-s3-<tenant>-<agent>` | `S3WorkloadPipelineStack` | Workload account stacks — one per LOB, triggered by S3 upload |

All platform infrastructure changes go through **git push to the platform repo**. The `PlatformPipelineStack` is self-mutating. Direct `cdk deploy` is only used for the one-time bootstrap of each pipeline stack.

---

## Part A — One-Time Platform Bootstrap

### Step A1 — Bootstrap the Platform Account

```bash
AWS_PROFILE=agentops-publisher npx cdk bootstrap aws://195698601974/us-east-1
```

### Step A2 — Create and Authorize a GitHub CodeStar Connection

The platform pipeline sources from GitHub. Create the connection:

```bash
AWS_PROFILE=agentops-publisher aws codestar-connections create-connection \
  --provider-type GitHub \
  --connection-name platform-github \
  --region us-east-1 \
  --query "ConnectionArn" --output text
```

Go to **AWS Console → (platform account) → Developer Tools → Connections → platform-github → Update pending connection** and authorize with GitHub. The connection must show `AVAILABLE` before proceeding.

### Step A3 — Set Platform Context Keys

In the platform repo's `cdk.context.json`:

```json
{
  "agenticai/organizationId":           "o-XXXXXXXXXX",
  "agenticai/platformAccountId":        "195698601974",
  "agenticai/platformNonprodAccountId": "195698601974",
  "agenticai/platformProdAccountId":    "195698601974",
  "agenticai/auditAccountId":           "195698601974",
  "agenticai/logArchiveAccountId":      "195698601974",
  "agenticai/registrySynthAccountId":   "195698601974",
  "agenticai/defaultRegion":            "us-east-1",
  "agenticai/pipelineRoleArn":          "arn:aws:iam::195698601974:role/Admin",
  "agenticai/pipelineSelection":        "platform",
  "agenticai/githubRepo":               "YOUR_ORG/YOUR_REPO",
  "agenticai/githubBranch":             "main",
  "agenticai/githubConnectionArn":      "arn:aws:codestar-connections:us-east-1:195698601974:connection/YOUR_CONNECTION_ID",
  "agenticai/inferenceModelRateLimits": [
    { "qualifiedModelId": "anthropic.claude-sonnet-5",  "requestsPerMinute": 1000, "tokensPerMinute": 5000000 },
    { "qualifiedModelId": "anthropic.claude-haiku-4-5", "requestsPerMinute": 2000, "tokensPerMinute": 10000000 },
    { "qualifiedModelId": "anthropic.claude-opus-4-8",  "requestsPerMinute": 200,  "tokensPerMinute": 1000000 }
  ]
}
```

Model IDs must use the **short form** (e.g. `anthropic.claude-haiku-4-5`, not the CDK versioned format). A zero-rate wildcard catch-all blocks every unlisted model ID.

### Step A4 — Bootstrap the Platform Pipeline (one-time only)

```bash
AWS_PROFILE=agentops-publisher npx cdk deploy \
  "aifactory-YOUR_TENANT-PlatformPipelineStack" \
  --context agenticai/pipelineSelection=platform \
  --require-approval never
```

Pipeline stages:

```
Source (GitHub) → Build (synth + tests) → UpdatePipeline (self-mutate) → Assets
  → Nonprod (GuardrailStack, RegistryStack, InferenceGatewayStack)
  → SecurityReview (manual approval)
  → Prod
```

**After this, all platform changes go through git push — never `cdk deploy` again.**

After the Nonprod stage completes, note the outputs written to `cdk.context.json`:

```json
"agenticai/inferenceM2mSecretArn": "arn:aws:secretsmanager:us-east-1:195698601974:secret:agenticai/inference-m2m/...",
"agenticai/inferenceGatewayUrl":   "https://agenticai-inference-nonprod-XXXX.gateway.bedrock-agentcore.us-east-1.amazonaws.com",
"agenticai/inferenceModelId":      "anthropic.claude-sonnet-5"
```

These are passed into every workload pipeline and injected as env vars into every agent runtime.

---

## Part B — Onboarding a New LOB (repeated per LOB)

Each LOB gets their own workload account and their own `S3WorkloadPipelineStack`. The LOB team owns their agent code and CDK workload stacks in their own repo. The platform team owns the pipeline infrastructure.

### Step B1 — Bootstrap the Workload Account

```bash
AWS_PROFILE=agentops-consumer npx cdk bootstrap \
  aws://YOUR_WORKLOAD_ACCOUNT_ID/us-east-1 \
  --trust 195698601974 \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

### Step B2 — Create the S3 Source Bucket

The LOB's CI job uploads a source zip here on every merge to `main`. CodePipeline triggers automatically off the new S3 object version.

Add to `bin/agentic-ai-platform.ts`:

```typescript
import { Bucket, BucketEncryption, BlockPublicAccess } from "aws-cdk-lib/aws-s3";
import { ArnPrincipal, PolicyStatement } from "aws-cdk-lib/aws-iam";

const lobSourceBucket = new Bucket(this, "LobSourceBucket-YOUR_TENANT", {
  bucketName: `agenticai-pipeline-source-YOUR_TENANT`,
  versioned: true,  // required by CodePipelineSource.s3()
  encryption: BucketEncryption.S3_MANAGED,
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
});

// Allow the LOB's GitLab CI runner to upload
lobSourceBucket.addToResourcePolicy(new PolicyStatement({
  principals: [new ArnPrincipal("arn:aws:iam::YOUR_WORKLOAD_ACCOUNT_ID:role/YOUR_CI_RUNNER_ROLE")],
  actions: ["s3:PutObject", "s3:GetBucketVersioning"],
  resources: [lobSourceBucket.bucketArn, `${lobSourceBucket.bucketArn}/*`],
}));
```

The LOB team provides their CI runner role ARN. The platform team provides the bucket name back to the LOB team.

Commit and push — the platform pipeline deploys the bucket.

### Step B3 — Instantiate `S3WorkloadPipelineStack`

Add to `bin/agentic-ai-platform.ts`:

```typescript
import { S3WorkloadPipelineStack } from "../pipelines/s3-workload-pipeline-stack";
import { Bucket } from "aws-cdk-lib/aws-s3";

const lobSourceBucket = Bucket.fromBucketName(app, "LobSource-YOUR_TENANT",
  "agenticai-pipeline-source-YOUR_TENANT");

new S3WorkloadPipelineStack(app, "aifactory-YOUR_TENANT-S3WorkloadPipelineStack", {
  env: { account: platformAccount, region },
  sourceBucket: lobSourceBucket,
  sourceObjectKey: "workload-source.zip",
  tenantId: "YOUR_TENANT",
  agentId: "primary",
  applicationId: "aifactory-YOUR_TENANT",
  costCentre: "YOUR_COST_CENTRE",
  workloadNonprodEnv: { account: "YOUR_WORKLOAD_ACCOUNT_ID", region },
  workloadProdEnv:    { account: "YOUR_WORKLOAD_ACCOUNT_ID", region },
  workloadNonprodAvailabilityZones: ["us-east-1a", "us-east-1b"],
  workloadProdAvailabilityZones:    ["us-east-1a", "us-east-1b"],
  inferenceM2mSecretArn: "<from cdk.context.json agenticai/inferenceM2mSecretArn>",
  inferenceGatewayUrl:   "<from cdk.context.json agenticai/inferenceGatewayUrl>",
  inferenceModelId:      "<from cdk.context.json agenticai/inferenceModelId>",
});
```

Bootstrap the pipeline stack once:

```bash
AWS_PROFILE=agentops-publisher npx cdk deploy \
  "aifactory-YOUR_TENANT-S3WorkloadPipelineStack" \
  --context agenticai/pipelineSelection=workload \
  --require-approval never
```

Pipeline stages:

```
Source (S3 object version) → Synth → UpdatePipeline (self-mutate) → Assets
  → Nonprod (NetworkStack, AppStack)
  → EvaluationGate → ProdApproval → Prod
```

**After this, the workload pipeline is triggered by S3 uploads from the LOB's CI — never `cdk deploy` again.**

### Step B4 — Hand Off to the LOB Team

Give the LOB team:

1. The **workload blueprint repo**: `git@ssh.gitlab.aws.dev:subhaviv/agentops-blueprint.git` (they clone this as their LOB repo starting point — see `WORKLOAD_SETUP.md` Step 1)
2. The **S3 bucket name**: `agenticai-pipeline-source-YOUR_TENANT`
3. The **ECR repo**: `YOUR_WORKLOAD_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/agenticai-nonprod-YOUR_TENANT-primary`
4. The **inference values** they need in their `cdk.context.json`:
   - `agenticai/inferenceM2mSecretArn`
   - `agenticai/inferenceGatewayUrl`
   - `agenticai/inferenceModelId`
5. A pointer to `WORKLOAD_SETUP.md`

The LOB team takes it from here. The platform team is not in the loop for agent deployments.

### Step B5 — Add the Agent Registry Record (after LOB deploys)

Once the LOB's agent is running and has an API Gateway endpoint, the platform team adds a registry record in `apps/platform-account/lib/registry-stack.ts`:

```typescript
if (props.myAgentA2aEndpointUrl) {
  const a2aCard = {
    protocolVersion: "0.3",
    name: "my-agent",
    description: "One-sentence description under 100 characters.",
    version: "1.0",
    url: props.myAgentA2aEndpointUrl,
    capabilities: { streaming: true },
    skills: [{ id: "my-skill", name: "My Skill", description: "What it does.", tags: ["your-domain"] }],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };

  const record = new CfnResource(this, "MyAgentRecord", {
    type: "AWS::AgentRegistry::RegistryRecord",
    properties: {
      RegistryId: this.gaRegistry.registryId,
      Name: "my-agent",
      DisplayName: "My Agent",
      Description: "Full description for the registry UI.",
      RecordType: "AGENT",
      RecordVersion: "1.0.0",
      Descriptors: { A2aAgentCard: { Data: JSON.stringify(a2aCard), DataSchemaVersion: "0.3" } },
      Tags: [
        { Key: "application-id", Value: props.applicationId },
        { Key: "agent-id",       Value: "my-agent" },
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

Wire the endpoint URL through `PlatformPipelineStack` → `PlatformDeploymentStage` → `RegistryStack` via a `cdk.context.json` key, then commit and push. The platform pipeline deploys it.

In nonprod the registry auto-approves records. In prod a curator must approve before the record becomes discoverable.

> **Changing `RecordType` on an existing record** cannot be done in-place. Delete first:
> ```bash
> aws cloudcontrol delete-resource \
>   --type-name "AWS::AgentRegistry::RegistryRecord" \
>   --identifier "RECORD_ARN" \
>   --profile agentops-publisher
> ```
> Then push to recreate.

---

## Reference: Key Platform ARNs and IDs

| Resource | Value |
|----------|-------|
| Platform account | `195698601974` |
| Calanthir workload account | `172873868821` |
| Platform pipeline | `agenticai-platform-pipeline` |
| Inference gateway ID | `agenticai-inference-nonprod-wainu7pcof` |
| Gateway base URL | `https://agenticai-inference-nonprod-wainu7pcof.gateway.bedrock-agentcore.us-east-1.amazonaws.com` |
| Gateway messages endpoint | `<base>/inference/v1/messages` |
| M2M secret ARN | `arn:aws:secretsmanager:us-east-1:195698601974:secret:agenticai/inference-m2m/agenticai-inference-nonprod-TxAKso` |
| Token endpoint | `https://agenticai-inference-nonprod-195698601974-us-east-1.auth.us-east-1.amazoncognito.com/oauth2/token` |
| M2M client ID (workstream) | `72uo0d5afst4tts6m14ktdg3dk` |
| OAuth scope | `agenticai-inference-nonprod-api/invoke` |
| External / Loom user pool | `us-east-1_NoErXe1QA` |
| GA Registry ID | `thx22kgS5M7oTMy7` |

---

## Common Pitfalls (Platform Team)

| Symptom | Cause | Fix |
|---------|-------|-----|
| Platform pipeline synth fails with W2531 | `nodejs20.x` Lambda runtime deprecated | Use `Runtime.NODEJS_22_X` everywhere |
| `cdk deploy` runs but pipeline ignores the change | Direct deploy bypasses self-mutation | Always git push — never direct `cdk deploy` after bootstrap |
| S3 pipeline does not trigger after LOB merge | Bucket versioning disabled or wrong object key | Verify `aws s3api get-bucket-versioning`; confirm `sourceObjectKey` matches the CI job |
| S3 `cp` denied in LOB CI | CI runner role missing `s3:PutObject` | Add the grant to the bucket resource policy in Step B2 |
| S3 pipeline self-mutates but loses S3 source | Bucket or key changed post-bootstrap | Re-bootstrap once with `cdk deploy` when changing `sourceBucket` or `sourceObjectKey` |
| Registry record appears as tool not agent | `RecordType: "CUSTOM"` | Use `RecordType: "AGENT"` with `Descriptors.A2aAgentCard` |
| CFN 409 on registry update | `RecordType` cannot be updated in-place | Delete via Cloud Control API, then push to recreate |
