#!/usr/bin/env bash
#
# Seed the private HAPI FHIR EHR with the HALO Patient-Journey ER patients only
# (the 6 patient-halo-er-*-bundle.json files in this dir).
#
# The EHR ALB is INTERNAL, so the POST runs from inside the VPC via a one-off
# Fargate task. ECS container-override has an 8 KB limit, so we DON'T ship the
# bundles in the override. Instead we upload them to a temp S3 prefix, generate
# presigned GET URLs, and pass only those URLs (+ the FHIR base) to the task.
# The task fetches each bundle with urllib and POSTs it as a FHIR transaction.
# python:3.12-slim needs no AWS CLI or task-role S3 grant - presigned URLs carry
# their own auth.
#
#   cd enterprise-mcp-governance-gateway/infra/ehr-fhir
#   ./seed-halo.sh
#
set -euo pipefail
cd "$(dirname "$0")"

STACK=agentops-ehr-fhir-nonprod
REGION=us-east-1
PROFILE=agentops-publisher

echo ">> Reading stack outputs..."
OUT=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" --profile "$PROFILE" \
        --query 'Stacks[0].Outputs' --output json)
FHIR_BASE=$(echo "$OUT" | python3 -c "import sys,json;print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='FhirBaseUrl'))")
SG=$(echo "$OUT" | python3 -c "import sys,json;print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='GatewayToolSecurityGroupId'))")
SUBNETS=$(echo "$OUT" | python3 -c "import sys,json;print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='PrivateSubnets'))")
SUB1=$(echo "$SUBNETS" | cut -d, -f1)
ACCOUNT=$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)
echo "   FHIR base: $FHIR_BASE"
echo "   SG:        $SG  subnet: $SUB1  account: $ACCOUNT"

# Temp S3 staging bucket (create if missing). Presigned URLs expire in 1h.
BUCKET="agentops-ehr-seed-${ACCOUNT}-${REGION}"
if ! aws s3api head-bucket --bucket "$BUCKET" --profile "$PROFILE" 2>/dev/null; then
  echo ">> Creating staging bucket ${BUCKET}..."
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --profile "$PROFILE" >/dev/null 2>&1 || true
fi

PREFIX="halo-seed-$(date +%s)"
echo ">> Uploading 6 Halo bundles to s3://${BUCKET}/${PREFIX}/ and presigning..."
URLS=()
for f in patient-halo-er-*-bundle.json; do
  key="${PREFIX}/${f}"
  aws s3api put-object --bucket "$BUCKET" --key "$key" --body "$f" --region "$REGION" --profile "$PROFILE" >/dev/null
  url=$(aws s3 presign "s3://${BUCKET}/${key}" --expires-in 3600 --region "$REGION" --profile "$PROFILE")
  URLS+=("$url")
done
URLS_JSON=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" "${URLS[@]}")
echo "   staged ${#URLS[@]} bundles"

EXEC_ROLE=$(aws ecs describe-task-definition --task-definition "$STACK" --region "$REGION" --profile "$PROFILE" \
  --query 'taskDefinition.executionRoleArn' --output text)

echo ">> Registering Halo seeder task definition..."
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/td.json" <<JSON
{
  "family": "${STACK}-seeder-halo",
  "cpu": "256", "memory": "512", "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "executionRoleArn": "${EXEC_ROLE}",
  "containerDefinitions": [
    {
      "name": "seeder", "image": "python:3.12-slim", "essential": true,
      "command": ["echo","start"],
      "logConfiguration": { "logDriver": "awslogs", "options": {
        "awslogs-group": "/agentops/ehr-fhir/nonprod",
        "awslogs-region": "${REGION}", "awslogs-stream-prefix": "seeder-halo" } }
    }
  ]
}
JSON
aws ecs register-task-definition --cli-input-json "file://$WORK/td.json" --region "$REGION" --profile "$PROFILE" >/dev/null

# The poster script + the URL manifest both live in S3 (presigned), so the ECS
# container override stays tiny (its 8 KB limit was the earlier failure). The
# override carries only two short presigned URLs + the FHIR base.
cat > "$WORK/run_seed.py" <<'PY'
import json, os, urllib.request, urllib.error
base = os.environ["FHIR_BASE"]
urls = json.loads(urllib.request.urlopen(os.environ["MANIFEST_URL"], timeout=60).read())
ok = True
for u in urls:
    try:
        data = urllib.request.urlopen(u, timeout=60).read()
    except Exception as e:
        print(f"  FAIL download: {e}"); ok = False; continue
    req = urllib.request.Request(base, data=data, method="POST",
        headers={"Content-Type": "application/fhir+json", "Accept": "application/fhir+json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())
        pat = next((e["response"]["location"].split("/")[1] for e in result.get("entry", [])
                    if e.get("response", {}).get("location", "").startswith("Patient/")), "?")
        print(f"  OK -> Patient {pat}")
    except urllib.error.HTTPError as e:
        print(f"  FAIL post: {e.read().decode()[:300]}"); ok = False
    except Exception as e:
        print(f"  FAIL post: {e}"); ok = False
print("SEED_DONE ok=" + str(ok))
PY
echo "$URLS_JSON" > "$WORK/manifest.json"
aws s3api put-object --bucket "$BUCKET" --key "${PREFIX}/run_seed.py" --body "$WORK/run_seed.py" --region "$REGION" --profile "$PROFILE" >/dev/null
aws s3api put-object --bucket "$BUCKET" --key "${PREFIX}/manifest.json" --body "$WORK/manifest.json" --region "$REGION" --profile "$PROFILE" >/dev/null
SCRIPT_URL=$(aws s3 presign "s3://${BUCKET}/${PREFIX}/run_seed.py" --expires-in 3600 --region "$REGION" --profile "$PROFILE")
MANIFEST_URL=$(aws s3 presign "s3://${BUCKET}/${PREFIX}/manifest.json" --expires-in 3600 --region "$REGION" --profile "$PROFILE")

# Shell-free command: an args ARRAY (no `sh -c`, so no nested-quote escaping -
# the earlier silent failure). Each element is literal JSON. The one-liner
# fetches run_seed.py from S3 and exec()s it; the script reads MANIFEST_URL +
# FHIR_BASE from the env.
BOOTSTRAP="import urllib.request,os;exec(urllib.request.urlopen(os.environ['SCRIPT_URL']).read())"

python3 - "$BOOTSTRAP" "$SCRIPT_URL" "$MANIFEST_URL" "$FHIR_BASE" > "$WORK/override.json" <<'PY'
import json, sys
bootstrap, script_url, manifest_url, fhir_base = sys.argv[1:5]
print(json.dumps({"containerOverrides":[{
  "name":"seeder",
  "command":["python3","-c",bootstrap],
  "environment":[
    {"name":"SCRIPT_URL","value":script_url},
    {"name":"MANIFEST_URL","value":manifest_url},
    {"name":"FHIR_BASE","value":fhir_base}
  ]}]}))
PY
echo "   override size: $(wc -c < "$WORK/override.json") bytes (limit 8192)"

echo ">> Running Halo seeder task..."
TASK_ARN=$(aws ecs run-task \
  --cluster "$STACK" --task-definition "${STACK}-seeder-halo" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[${SUB1}],securityGroups=[${SG}],assignPublicIp=DISABLED}" \
  --overrides "file://$WORK/override.json" \
  --region "$REGION" --profile "$PROFILE" --query 'tasks[0].taskArn' --output text)
echo "   task: $TASK_ARN"
aws ecs wait tasks-stopped --cluster "$STACK" --tasks "$TASK_ARN" --region "$REGION" --profile "$PROFILE"
EXIT=$(aws ecs describe-tasks --cluster "$STACK" --tasks "$TASK_ARN" --region "$REGION" --profile "$PROFILE" \
        --query 'tasks[0].containers[0].exitCode' --output text)
echo "   seeder exit code: $EXIT"
sleep 6
echo ">> Seeder logs:"
aws logs tail /agentops/ehr-fhir/nonprod --since 5m --region "$REGION" --profile "$PROFILE" 2>/dev/null \
  | grep -i "seeder-halo\|OK ->\|FAIL\|SEED_DONE\|Patient" | tail -30 || true

echo ">> Cleaning up staged S3 objects..."
aws s3 rm "s3://${BUCKET}/${PREFIX}/" --recursive --region "$REGION" --profile "$PROFILE" >/dev/null 2>&1 || true

# ---- Hard-proof read-back: count + list patients from inside the VPC ----
echo ">> Read-back: counting patients in the EHR..."
READBACK='import json,os,urllib.request
b=os.environ["FHIR_BASE"]
tot=json.loads(urllib.request.urlopen(b+"/Patient?_summary=count",timeout=60).read())
print("PATIENT_TOTAL="+str(tot.get("total","?")))
lst=json.loads(urllib.request.urlopen(b+"/Patient?_count=50&_elements=id,name",timeout=60).read())
for e in lst.get("entry",[]):
    r=e["resource"]; nm=""
    if r.get("name"): n=r["name"][0]; nm=" ".join(n.get("given",[])+[n.get("family","")])
    print("PATIENT "+r.get("id","?")+" | "+nm.strip())'
RB_OVERRIDE=$(python3 - "$READBACK" "$FHIR_BASE" <<'PY'
import json, sys
readback, fhir_base = sys.argv[1], sys.argv[2]
print(json.dumps({"containerOverrides":[{
  "name":"seeder","command":["python3","-c",readback],
  "environment":[{"name":"FHIR_BASE","value":fhir_base}]}]}))
PY
)
RB_TASK=$(aws ecs run-task \
  --cluster "$STACK" --task-definition "${STACK}-seeder-halo" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[${SUB1}],securityGroups=[${SG}],assignPublicIp=DISABLED}" \
  --overrides "$RB_OVERRIDE" \
  --region "$REGION" --profile "$PROFILE" --query 'tasks[0].taskArn' --output text)
echo "   read-back task: $RB_TASK"
aws ecs wait tasks-stopped --cluster "$STACK" --tasks "$RB_TASK" --region "$REGION" --profile "$PROFILE"
sleep 6
echo ">> Read-back result (hard proof of what is in HAPI):"
aws logs tail /agentops/ehr-fhir/nonprod --since 3m --region "$REGION" --profile "$PROFILE" 2>/dev/null \
  | grep -E "PATIENT_TOTAL|PATIENT " | tail -60 || true
echo ">> Done."
