#!/usr/bin/env bash
# onboard-lob.sh — Add a new LOB to the platform repo.
#
# What this does:
#   1. Validates inputs
#   2. Adds the versioned S3 source bucket + CI runner IAM grant to bin/agentic-ai-platform.ts
#   3. Adds the S3WorkloadPipelineStack instantiation to bin/agentic-ai-platform.ts
#   4. Commits the changes (does NOT push — platform team reviews and pushes)
#
# Usage:
#   ./scripts/onboard-lob.sh \
#     --tenant           members-services     \
#     --workload-account 172873868821
#
# Optional flags:
#   --ci-runner-role  arn:aws:iam::172873868821:role/GitLabCIRunner
#                     (add the S3 PutObject grant for the LOB CI runner;
#                      can be omitted now and added later in a follow-up commit)
#   --agent-id        primary             (default: primary)
#   --cost-centre     engineering         (default: engineering)
#   --region          us-east-1           (default: us-east-1)
#   --azs             us-east-1a,us-east-1b  (default: us-east-1a,us-east-1b)
#   --dry-run                             (print what would be done, no file changes)
#
# Prerequisites:
#   - Run from the root of the platform repo
#   - Working tree must be clean (script will check)
#   - node_modules installed (npm ci)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRYPOINT="$REPO_ROOT/bin/agentic-ai-platform.ts"

# ── Defaults ──────────────────────────────────────────────────────────────────
TENANT=""
WORKLOAD_ACCOUNT=""
PLATFORM_ACCOUNT="195698601974"
CI_RUNNER_ROLE=""
AGENT_ID="primary"
COST_CENTRE="engineering"
REGION="us-east-1"
AZS="us-east-1a,us-east-1b"
DRY_RUN=false

# ── Arg parse ─────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant)            TENANT="$2";            shift 2 ;;
    --workload-account)  WORKLOAD_ACCOUNT="$2";  shift 2 ;;
    --platform-account)  PLATFORM_ACCOUNT="$2";  shift 2 ;;
    --ci-runner-role)    CI_RUNNER_ROLE="$2";    shift 2 ;;
    --agent-id)          AGENT_ID="$2";          shift 2 ;;
    --cost-centre)       COST_CENTRE="$2";       shift 2 ;;
    --region)            REGION="$2";            shift 2 ;;
    --azs)               AZS="$2";              shift 2 ;;
    --dry-run)           DRY_RUN=true;           shift   ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

# ── Validate ──────────────────────────────────────────────────────────────────
errors=()
[[ -z "$TENANT"           ]] && errors+=("--tenant is required")
[[ -z "$WORKLOAD_ACCOUNT" ]] && errors+=("--workload-account is required")

if [[ -n "$TENANT" ]]; then
  if ! [[ "$TENANT" =~ ^[a-z][a-z0-9-]{1,38}[a-z0-9]$ ]]; then
    errors+=("--tenant must be lowercase alphanumeric+hyphens, 3-40 chars (e.g. member-services)")
  fi
  # Role name check: AgenticAI-WLP-<tenant>-<agent>-RegistrySynth must be ≤64 chars
  role_name="AgenticAI-WLP-${TENANT}-${AGENT_ID}-RegistrySynth"
  if [[ ${#role_name} -gt 64 ]]; then
    errors+=("tenant+agent-id too long — '${role_name}' (${#role_name} chars) exceeds 64-char IAM role name limit")
  fi
fi

if [[ -n "$WORKLOAD_ACCOUNT" ]]; then
  if ! [[ "$WORKLOAD_ACCOUNT" =~ ^[0-9]{12}$ ]]; then
    errors+=("--workload-account must be a 12-digit AWS account ID")
  fi
fi

if ! [[ "$PLATFORM_ACCOUNT" =~ ^[0-9]{12}$ ]]; then
  errors+=("--platform-account must be a 12-digit AWS account ID")
fi

if [[ -n "$CI_RUNNER_ROLE" ]]; then
  if ! [[ "$CI_RUNNER_ROLE" =~ ^arn:aws:iam::[0-9]{12}:role/ ]]; then
    errors+=("--ci-runner-role must be a valid IAM role ARN (arn:aws:iam::ACCOUNT:role/NAME)")
  fi
fi

if [[ ${#errors[@]} -gt 0 ]]; then
  echo "Errors:" >&2
  for e in "${errors[@]}"; do echo "  • $e" >&2; done
  exit 1
fi

# ── Working-tree clean check ───────────────────────────────────────────────────
if [[ "$DRY_RUN" == false ]]; then
  if ! git -C "$REPO_ROOT" diff --quiet || ! git -C "$REPO_ROOT" diff --cached --quiet; then
    echo "Error: working tree has uncommitted changes. Commit or stash them first." >&2
    exit 1
  fi
fi

# ── Derived values ─────────────────────────────────────────────────────────────
BUCKET_NAME="agenticai-pipeline-source-${TENANT}"
PIPELINE_NAME="agenticai-workload-s3-${TENANT}-${AGENT_ID}"
APPLICATION_ID="aifactory-${TENANT}"

# Parse AZs into a TypeScript array literal: ["us-east-1a","us-east-1b"]
IFS=',' read -ra AZ_ARRAY <<< "$AZS"
AZ_TS="[$(printf '"%s",' "${AZ_ARRAY[@]}" | sed 's/,$//')]"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Onboarding LOB: ${TENANT}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Tenant ID         : $TENANT"
echo "  Agent ID          : $AGENT_ID"
echo "  Application ID    : $APPLICATION_ID"
echo "  Cost centre       : $COST_CENTRE"
echo "  Platform account  : $PLATFORM_ACCOUNT"
echo "  Workload account  : $WORKLOAD_ACCOUNT"
[[ -n "$CI_RUNNER_ROLE" ]] && echo "  CI runner role    : $CI_RUNNER_ROLE" || echo "  CI runner role    : (none - add later with --ci-runner-role)"
echo "  S3 bucket         : $BUCKET_NAME"
echo "  Pipeline name     : $PIPELINE_NAME"
echo "  Region            : $REGION"
echo "  Availability zones: $AZS"
[[ "$DRY_RUN" == true ]] && echo "  Mode              : DRY RUN — no files changed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [[ "$DRY_RUN" == true ]]; then
  echo "Dry run — would inject the following blocks into $ENTRYPOINT"
  echo "and commit with message: 'feat(lob): onboard ${TENANT}'"
  exit 0
fi

# ── Guard: duplicate check ─────────────────────────────────────────────────────
if grep -q "agenticai-pipeline-source-${TENANT}" "$ENTRYPOINT"; then
  echo "Error: tenant '${TENANT}' already exists in $ENTRYPOINT" >&2
  exit 1
fi

# ── Inject: S3WorkloadPipelineStack (Step B2+B3) ─────────────────────────────
# The stack creates its own source bucket internally (agenticai-pipeline-source-<tenant>).
# ciRunnerRoleArn is optional — omit now, add later via --ci-runner-role.
BUCKET_BLOCK=""

PIPELINE_BLOCK=$(cat <<TSBLOCK

  // ── LOB: ${TENANT} — workload pipeline ───────────────────────────────────
  // Added by onboard-lob.sh. S3 source bucket created inside the stack.
  // Bootstrap once (run as platform account ${PLATFORM_ACCOUNT}):
  //   npx cdk deploy \\
  //     "aifactory-${TENANT}-S3WorkloadPipelineStack" \\
  //     --context stage=pipeline --context agenticai/pipelineSelection=workload \\
  //     --require-approval never
  // After bootstrap, all workload changes trigger via S3 upload from the LOB CI job.
  new S3WorkloadPipelineStack(app, "aifactory-${TENANT}-S3WorkloadPipelineStack", {
    env: { account: "${PLATFORM_ACCOUNT}", region: deploymentRegion() },
    sourceObjectKey: "workload-source.zip",
$(if [[ -n "$CI_RUNNER_ROLE" ]]; then echo "    ciRunnerRoleArn: \"${CI_RUNNER_ROLE}\","; fi)
    tenantId: "${TENANT}",
    agentId: "${AGENT_ID}",
    applicationId: "${APPLICATION_ID}",
    costCentre: "${COST_CENTRE}",
    workloadNonprodEnv: { account: "${WORKLOAD_ACCOUNT}", region: "${REGION}" },
    workloadProdEnv:    { account: "${WORKLOAD_ACCOUNT}", region: "${REGION}" },
    workloadNonprodAvailabilityZones: ${AZ_TS},
    workloadProdAvailabilityZones:    ${AZ_TS},
    inferenceM2mSecretArn: String(app.node.tryGetContext("agenticai/inferenceM2mSecretArn") ?? ""),
    inferenceGatewayUrl:   String(app.node.tryGetContext("agenticai/inferenceGatewayUrl") ?? ""),
    inferenceModelId:      String(app.node.tryGetContext("agenticai/inferenceModelId") ?? ""),
    synthContext: sharedSynthContext,
  });
TSBLOCK
)

# ── Ensure required imports are present ───────────────────────────────────────
python3 - "$ENTRYPOINT" <<'PYEOF_IMPORTS'
import sys, re

path = sys.argv[1]
with open(path) as f:
    src = f.read()

changed = False

if 'S3WorkloadPipelineStack' not in src:
    src = src.replace(
        'import { WorkloadPipelineStack }',
        'import { WorkloadPipelineStack }\nimport { S3WorkloadPipelineStack } from "../pipelines/s3-workload-pipeline-stack";'
    )
    changed = True

if changed:
    with open(path, 'w') as f:
        f.write(src)
    print("Imports updated.")
else:
    print("Imports already present.")
PYEOF_IMPORTS

# ── Inject blocks inside the `pipeline` case, after the last stack instantiation
# Anchor: the last occurrence of `synthContext: sharedSynthContext,` followed by
# `\n    });\n  }\n  break;` — unique to the end of the pipeline case block.
python3 - "$ENTRYPOINT" "$BUCKET_BLOCK" "$PIPELINE_BLOCK" <<'PYEOF'
import sys

path = sys.argv[1]
bucket_block = sys.argv[2]
pipeline_block = sys.argv[3]

with open(path) as f:
    src = f.read()

# Find `    break;\n` that closes the `pipeline` case.
# The pipeline case is the only one that contains `sharedSynthContext` — use
# its last occurrence to locate the right break.
synth_ctx_pos = src.rfind("synthContext: sharedSynthContext,")
if synth_ctx_pos == -1:
    print("ERROR: could not find 'synthContext: sharedSynthContext,' in entrypoint", file=sys.stderr)
    sys.exit(1)

# Find the next `    break;` after that position
break_marker = "\n    break;"
insert_at = src.find(break_marker, synth_ctx_pos)
if insert_at == -1:
    print("ERROR: could not find closing break after sharedSynthContext", file=sys.stderr)
    sys.exit(1)

new_src = src[:insert_at] + "\n" + bucket_block + pipeline_block + src[insert_at:]
with open(path, "w") as f:
    f.write(new_src)

print("Injected LOB blocks into entrypoint.")
PYEOF

# ── TypeScript compile check ───────────────────────────────────────────────────
echo "Checking TypeScript..."
cd "$REPO_ROOT"
if ! npx tsc --noEmit 2>&1; then
  echo ""
  echo "TypeScript compile failed — reverting changes." >&2
  git -C "$REPO_ROOT" checkout -- "$ENTRYPOINT"
  exit 1
fi
echo "TypeScript OK."

# ── Grant platform synth CodeBuild role cross-account lookup permissions ───────
# CDK synth needs sts:AssumeRole on the workload CDK bootstrap lookup role.
# synthCodeBuildDefaults.rolePolicy in code only takes effect after a self-mutate,
# which requires synth to pass first. This inline policy bridges the gap.
echo "Granting synth CodeBuild role permission to assume CDK lookup roles in ${WORKLOAD_ACCOUNT}..."
SYNTH_ROLE_NAME=$(AWS_PROFILE=agentops-publisher aws iam list-roles \
  --query "Roles[?starts_with(RoleName, 'aifactory-calanthir-Platf-PlatformPipelineBuildSynt')].RoleName" \
  --output text 2>/dev/null)
if [[ -z "$SYNTH_ROLE_NAME" || "$SYNTH_ROLE_NAME" == "None" ]]; then
  echo "Warning: platform synth CodeBuild role not found — skipping IAM grant." >&2
  echo "  Re-run this step after the pipeline deploys once." >&2
else
  echo "  Found synth role: $SYNTH_ROLE_NAME"
  AWS_PROFILE=agentops-publisher aws iam put-role-policy \
    --role-name "$SYNTH_ROLE_NAME" \
    --policy-name "AgenticAI-LobLookup-${TENANT}" \
    --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Sid\": \"CdkCrossAccountLookup$(echo "$TENANT" | tr -d '-')\",
    \"Effect\": \"Allow\",
    \"Action\": [\"sts:AssumeRole\", \"sts:TagSession\"],
    \"Resource\": [
      \"arn:aws:iam::${WORKLOAD_ACCOUNT}:role/cdk-hnb659fds-lookup-role-${WORKLOAD_ACCOUNT}-${REGION}\",
      \"arn:aws:iam::${WORKLOAD_ACCOUNT}:role/cdk-hnb659fds-file-publishing-role-${WORKLOAD_ACCOUNT}-${REGION}\",
      \"arn:aws:iam::${WORKLOAD_ACCOUNT}:role/cdk-hnb659fds-image-publishing-role-${WORKLOAD_ACCOUNT}-${REGION}\",
      \"arn:aws:iam::${WORKLOAD_ACCOUNT}:role/cdk-hnb659fds-deploy-role-${WORKLOAD_ACCOUNT}-${REGION}\"
    ]
  }]
}"
  echo "  IAM inline policy 'AgenticAI-LobLookup-${TENANT}' attached."
fi

# ── Commit ────────────────────────────────────────────────────────────────────
git -C "$REPO_ROOT" add "$ENTRYPOINT"
git -C "$REPO_ROOT" commit -m "feat(lob): onboard ${TENANT}

Add S3 source bucket and S3WorkloadPipelineStack for tenant '${TENANT}'.
Workload account: ${WORKLOAD_ACCOUNT}. CI runner role: ${CI_RUNNER_ROLE}.

Next steps:
  1. Push this commit — the platform pipeline deploys the S3 bucket.
  2. Bootstrap the workload pipeline once (run as platform account ${PLATFORM_ACCOUNT}):
       npx cdk deploy \\
         'aifactory-${TENANT}-S3WorkloadPipelineStack' \\
         --context stage=pipeline --context agenticai/pipelineSelection=workload \\
         --require-approval never
  3. Hand off to the LOB team (see docs/PLATFORM_SETUP.md Step B4).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

echo ""
echo "✓ Committed. Next steps:"
echo ""
echo "  1. Review the diff:  git show HEAD"
echo "  2. Push:             git push origin main"
echo "     The platform pipeline will deploy the S3 bucket automatically."
echo ""
echo "  3. Bootstrap the workload pipeline (one-time, run as platform account ${PLATFORM_ACCOUNT}):"
echo "       npx cdk deploy \\"
echo "         'aifactory-${TENANT}-S3WorkloadPipelineStack' \\"
echo "         --context stage=pipeline --context agenticai/pipelineSelection=workload \\"
echo "         --require-approval never"
echo ""
echo "  4. Hand off to the LOB team (docs/PLATFORM_SETUP.md Step B4):"
echo "       Bucket : ${BUCKET_NAME}"
echo "       ECR    : ${WORKLOAD_ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/agenticai-nonprod-${TENANT}-${AGENT_ID}"
echo "       Blueprint repo: git@ssh.gitlab.aws.dev:subhaviv/agentops-blueprint.git"
echo ""
