#!/usr/bin/env bash
#
# seed-ehr.sh -- ONE reusable seeder for the private HAPI FHIR EHR.
#
# The EHR ALB is INTERNAL, so a POST must originate INSIDE the VPC. This runs a
# one-off Fargate task that fetches each bundle (via presigned S3 URL) and POSTs
# it as a FHIR transaction, then reads back the patient count as hard proof.
# ECS container-override has an 8 KB limit, so bundles + the poster script are
# staged in S3 and only presigned URLs ride in the override.
#
# Use this instead of a per-dataset seed-*.sh. Pass the bundle GLOB:
#
#   cd enterprise-mcp-governance-gateway/infra/ehr-fhir
#   ./seed-ehr.sh 'patient-onc-*-bundle.json'      # oncology set
#   ./seed-ehr.sh 'patient-halo-er-*-bundle.json'  # ER set
#   ./seed-ehr.sh                                   # ALL patient-*-bundle.json
#
# Optional 2nd arg = a short label used in the ECS log stream / task family
# (defaults to a slug derived from the glob).
#
set -euo pipefail
cd "$(dirname "$0")"

GLOB="${1:-patient-*-bundle.json}"
if [ "$GLOB" = "patient-*-bundle.json" ]; then
  LABEL="${2:-all}"
else
  LABEL="${2:-$(echo "$GLOB" | sed -e 's/patient-//' -e 's/-\*.*//' -e 's/[^a-zA-Z0-9]/-/g')}"
fi
[ -n "$LABEL" ] || LABEL="all"

STACK=agentops-ehr-fhir-nonprod
REGION=us-east-1
PROFILE=agentops-publisher

# Expand the glob now and fail early if it matches nothing.
shopt -s nullglob
FILES=( $GLOB )
shopt -u nullglob
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "ERROR: no bundles match glob: $GLOB (run the generator first)"; exit 1
fi
echo ">> Seeding ${#FILES[@]} bundle(s) matching '$GLOB' (label: $LABEL)"

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

BUCKET="agentops-ehr-seed-${ACCOUNT}-${REGION}"
if ! aws s3api head-bucket --bucket "$BUCKET" --profile "$PROFILE" 2>/dev/null; then
  echo ">> Creating staging bucket ${BUCKET}..."
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --profile "$PROFILE" >/dev/null 2>&1 || true
fi

PREFIX="${LABEL}-seed-$(date +%s)"
echo ">> Uploading bundles to s3://${BUCKET}/${PREFIX}/ and presigning..."
URLS=()
for f in "${FILES[@]}"; do
  key="${PREFIX}/${f}"
  aws s3api put-object --bucket "$BUCKET" --key "$key" --body "$f" --region "$REGION" --profile "$PROFILE" >/dev/null
  url=$(aws s3 presign "s3://${BUCKET}/${key}" --expires-in 3600 --region "$REGION" --profile "$PROFILE")
  URLS+=("$url")
done
URLS_JSON=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" "${URLS[@]}")
echo "   staged ${#URLS[@]} bundles"

EXEC_ROLE=$(aws ecs describe-task-definition --task-definition "$STACK" --region "$REGION" --profile "$PROFILE" \
  --query 'taskDefinition.executionRoleArn' --output text)

TD_FAMILY="${STACK}-seeder-${LABEL}"
STREAM="seeder-${LABEL}"
echo ">> Registering seeder task definition ($TD_FAMILY)..."
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/td.json" <<JSON
{
  "family": "${TD_FAMILY}",
  "cpu": "256", "memory": "512", "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "executionRoleArn": "${EXEC_ROLE}",
  "containerDefinitions": [
    {
      "name": "seeder", "image": "python:3.12-slim", "essential": true,
      "command": ["echo","start"],
      "logConfiguration": { "logDriver": "awslogs", "options": {
        "awslogs-group": "/agentops/ehr-fhir/nonprod",
        "awslogs-region": "${REGION}", "awslogs-stream-prefix": "${STREAM}" } }
    }
  ]
}
JSON
aws ecs register-task-definition --cli-input-json "file://$WORK/td.json" --region "$REGION" --profile "$PROFILE" >/dev/null

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

echo ">> Running seeder task..."
TASK_ARN=$(aws ecs run-task \
  --cluster "$STACK" --task-definition "$TD_FAMILY" --launch-type FARGATE \
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
  | grep -iE "${STREAM}|OK ->|FAIL|SEED_DONE|Patient" | tail -40 || true

echo ">> Cleaning up staged S3 objects..."
aws s3 rm "s3://${BUCKET}/${PREFIX}/" --recursive --region "$REGION" --profile "$PROFILE" >/dev/null 2>&1 || true

echo ">> Read-back: counting patients in the EHR..."
READBACK='import json,os,urllib.request
b=os.environ["FHIR_BASE"]
tot=json.loads(urllib.request.urlopen(b+"/Patient?_summary=count",timeout=60).read())
print("PATIENT_TOTAL="+str(tot.get("total","?")))
lst=json.loads(urllib.request.urlopen(b+"/Patient?_count=100&_elements=id,name",timeout=60).read())
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
  --cluster "$STACK" --task-definition "$TD_FAMILY" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[${SUB1}],securityGroups=[${SG}],assignPublicIp=DISABLED}" \
  --overrides "$RB_OVERRIDE" \
  --region "$REGION" --profile "$PROFILE" --query 'tasks[0].taskArn' --output text)
echo "   read-back task: $RB_TASK"
aws ecs wait tasks-stopped --cluster "$STACK" --tasks "$RB_TASK" --region "$REGION" --profile "$PROFILE"
sleep 6
echo ">> Read-back result (hard proof of what is in HAPI):"
aws logs tail /agentops/ehr-fhir/nonprod --since 3m --region "$REGION" --profile "$PROFILE" 2>/dev/null \
  | grep -E "PATIENT_TOTAL|PATIENT " | tail -80 || true
echo ">> Done."
