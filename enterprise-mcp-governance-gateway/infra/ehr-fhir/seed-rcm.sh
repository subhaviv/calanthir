#!/usr/bin/env bash
#
# Seed the private HAPI FHIR EHR with demo patients for the two demos:
#   - RCM:             7 bundles from the rcm-agent demo-patients repo
#   - Patient Journey: 6 ER journey bundles in this dir (patient-demo-er-*)
#
# The EHR ALB is INTERNAL, so the POST runs from inside the VPC via a one-off
# Fargate task. We ship the bundles + a portable restore script into the task
# as a base64 tarball env var (no image build, no volume), decode, and run.
#
# Reuses the exact ID-rewrite + transaction logic from the RCM repo's
# restore_local.py (numeric IDs -> demo-<id>, references rewritten to match).
#
#   cd enterprise-mcp-governance-gateway/infra/ehr-fhir
#   ./seed-rcm.sh
#
set -euo pipefail
cd "$(dirname "$0")"

STACK=agentops-ehr-fhir-nonprod
REGION=us-east-1
PROFILE=agentops-publisher
RCM_BUNDLES="/Users/subhaviv/Documents/src/healthcare/rcm-agent/demo-patients/fhir-bundles"

echo ">> Reading stack outputs..."
OUT=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" --profile "$PROFILE" \
        --query 'Stacks[0].Outputs' --output json)
FHIR_BASE=$(echo "$OUT" | python3 -c "import sys,json;print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='FhirBaseUrl'))")
SG=$(echo "$OUT" | python3 -c "import sys,json;print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='GatewayToolSecurityGroupId'))")
SUBNETS=$(echo "$OUT" | python3 -c "import sys,json;print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='PrivateSubnets'))")
SUB1=$(echo "$SUBNETS" | cut -d, -f1)
echo "   FHIR base: $FHIR_BASE"
echo "   SG:        $SG  subnet: $SUB1"

# ---- Build the in-task payload: a portable restore script + all bundles ----
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bundles"
cp "$RCM_BUNDLES"/patient-*-bundle.json "$WORK/bundles/"
cp ./patient-demo-er-*-bundle.json "$WORK/bundles/"
echo "   staged $(ls "$WORK/bundles" | wc -l | tr -d ' ') bundle files (RCM + ER)"

cat > "$WORK/run_seed.py" <<'PY'
import json, re, sys, pathlib, urllib.request, urllib.error
BASE = sys.argv[1]
BUNDLES_DIR = pathlib.Path("/seed/bundles")
def fix_id(rid):
    return f"sterling-{rid}" if rid and re.fullmatch(r"\d+", rid) else rid
def fix_refs(obj):
    if isinstance(obj, dict):
        if "reference" in obj and isinstance(obj["reference"], str):
            parts = obj["reference"].split("/")
            if len(parts) == 2 and re.fullmatch(r"\d+", parts[1]):
                obj["reference"] = f"{parts[0]}/sterling-{parts[1]}"
        return {k: fix_refs(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [fix_refs(i) for i in obj]
    return obj
ok = True
for bundle_file in sorted(BUNDLES_DIR.glob("*.json")):
    with open(bundle_file) as f:
        bundle = json.load(f)
    # If the bundle already carries request entries (eMed demo), post as-is.
    has_requests = any("request" in e for e in bundle.get("entry", []))
    if has_requests:
        tx = json.dumps(bundle).encode()
    else:
        entries = []
        for e in bundle.get("entry", []):
            r = fix_refs(e.get("resource", {}))
            rid = fix_id(r.get("id", ""))
            r["id"] = rid
            rt = r.get("resourceType", "")
            entries.append({"resource": r, "request": {"method": "PUT", "url": f"{rt}/{rid}"}})
        tx = json.dumps({"resourceType": "Bundle", "type": "transaction", "entry": entries}).encode()
    req = urllib.request.Request(BASE, data=tx, method="POST",
                                 headers={"Content-Type": "application/fhir+json", "Accept": "application/fhir+json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())
        pat_id = next((e["response"]["location"].split("/")[1]
                       for e in result.get("entry", [])
                       if e.get("response", {}).get("location", "").startswith("Patient/")), "?")
        print(f"  OK {bundle_file.name} -> Patient {pat_id}")
    except urllib.error.HTTPError as e:
        print(f"  FAIL {bundle_file.name}: {e.read().decode()[:300]}")
        ok = False
    except Exception as e:
        print(f"  FAIL {bundle_file.name}: {e}")
        ok = False
print("SEED_DONE ok=" + str(ok))
sys.exit(0 if ok else 1)
PY

TARB64=$(cd "$WORK" && tar czf - run_seed.py bundles | base64 | tr -d '\n')
echo "   payload size: ${#TARB64} base64 chars"

EXEC_ROLE=$(aws ecs describe-task-definition --task-definition "$STACK" --region "$REGION" --profile "$PROFILE" \
  --query 'taskDefinition.executionRoleArn' --output text)
echo "   exec role: $EXEC_ROLE"

echo ">> Registering RCM seeder task definition (python:3.12-slim)..."
cat > "$WORK/td.json" <<JSON
{
  "family": "${STACK}-seeder-rcm",
  "cpu": "256",
  "memory": "512",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "executionRoleArn": "${EXEC_ROLE}",
  "containerDefinitions": [
    {
      "name": "seeder",
      "image": "python:3.12-slim",
      "essential": true,
      "entryPoint": ["sh","-c"],
      "command": ["echo start"],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/agentops/ehr-fhir/nonprod",
          "awslogs-region": "${REGION}",
          "awslogs-stream-prefix": "seeder-rcm"
        }
      }
    }
  ]
}
JSON
aws ecs register-task-definition --cli-input-json "file://$WORK/td.json" --region "$REGION" --profile "$PROFILE" >/dev/null
echo "   registered ${STACK}-seeder-rcm"

# In-container: decode tarball to /seed, run the restore script against the ALB.
INSCRIPT='mkdir -p /seed && echo "$SEED_TAR_B64" | base64 -d | tar xzf - -C /seed && python3 /seed/run_seed.py "$FHIR_BASE"'
OVERRIDE=$(python3 - "$INSCRIPT" "$TARB64" "$FHIR_BASE" <<'PY'
import json, sys
inscript, tarb64, fhir_base = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({"containerOverrides":[{
  "name":"seeder",
  "command":["sh","-c",inscript],
  "environment":[
    {"name":"SEED_TAR_B64","value":tarb64},
    {"name":"FHIR_BASE","value":fhir_base}
  ]
}]}))
PY
)
echo "$OVERRIDE" > "$WORK/override.json"

echo ">> Running RCM seeder task..."
TASK_ARN=$(aws ecs run-task \
  --cluster "$STACK" \
  --task-definition "${STACK}-seeder-rcm" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[${SUB1}],securityGroups=[${SG}],assignPublicIp=DISABLED}" \
  --overrides "file://$WORK/override.json" \
  --region "$REGION" --profile "$PROFILE" \
  --query 'tasks[0].taskArn' --output text)
echo "   task: $TASK_ARN"

echo ">> Waiting for seeder to finish..."
aws ecs wait tasks-stopped --cluster "$STACK" --tasks "$TASK_ARN" --region "$REGION" --profile "$PROFILE"
EXIT=$(aws ecs describe-tasks --cluster "$STACK" --tasks "$TASK_ARN" --region "$REGION" --profile "$PROFILE" \
        --query 'tasks[0].containers[0].exitCode' --output text)
echo "   seeder exit code: $EXIT"
sleep 6
echo ">> Seeder logs:"
aws logs tail /agentops/ehr-fhir/nonprod --since 5m --region "$REGION" --profile "$PROFILE" 2>/dev/null | grep -i "seeder-rcm\|OK \|FAIL\|SEED_DONE\|Patient" | tail -40 || true
echo ">> Done."
