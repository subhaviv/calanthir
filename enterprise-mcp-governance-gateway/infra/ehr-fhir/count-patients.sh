#!/usr/bin/env bash
#
# READ-ONLY: count + list the patients currently in the private EHR.
# Pure GET (no writes), so it cannot create or duplicate anything.
# Runs a one-off Fargate task inside the VPC (the ALB is internal).
#
#   cd enterprise-mcp-governance-gateway/infra/ehr-fhir
#   ./count-patients.sh
#
set -euo pipefail
cd "$(dirname "$0")"
STACK=agentops-ehr-fhir-nonprod; REGION=us-east-1; PROFILE=agentops-publisher

OUT=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" --profile "$PROFILE" --query 'Stacks[0].Outputs' --output json)
FHIR_BASE=$(echo "$OUT" | python3 -c "import sys,json;print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='FhirBaseUrl'))")
SG=$(echo "$OUT" | python3 -c "import sys,json;print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='GatewayToolSecurityGroupId'))")
SUB1=$(echo "$OUT" | python3 -c "import sys,json;print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='PrivateSubnets'))" | cut -d, -f1)
EXEC_ROLE=$(aws ecs describe-task-definition --task-definition "$STACK" --region "$REGION" --profile "$PROFILE" --query 'taskDefinition.executionRoleArn' --output text)

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/td.json" <<JSON
{ "family": "${STACK}-count", "cpu":"256","memory":"512","networkMode":"awsvpc",
  "requiresCompatibilities":["FARGATE"], "executionRoleArn":"${EXEC_ROLE}",
  "containerDefinitions":[{"name":"count","image":"python:3.12-slim","essential":true,
    "command":["echo","start"],
    "logConfiguration":{"logDriver":"awslogs","options":{
      "awslogs-group":"/agentops/ehr-fhir/nonprod","awslogs-region":"${REGION}","awslogs-stream-prefix":"count"}}}]}
JSON
aws ecs register-task-definition --cli-input-json "file://$WORK/td.json" --region "$REGION" --profile "$PROFILE" >/dev/null

READBACK='import json,os,urllib.request
b=os.environ["FHIR_BASE"]
tot=json.loads(urllib.request.urlopen(b+"/Patient?_summary=count",timeout=60).read())
print("PATIENT_TOTAL="+str(tot.get("total","?")))
lst=json.loads(urllib.request.urlopen(b+"/Patient?_count=100&_elements=id,name",timeout=60).read())
for e in lst.get("entry",[]):
    r=e["resource"]; nm=""
    if r.get("name"): n=r["name"][0]; nm=" ".join(n.get("given",[])+[n.get("family","")])
    print("PATIENT "+r.get("id","?")+" | "+nm.strip())'
OVERRIDE=$(python3 - "$READBACK" "$FHIR_BASE" <<'PY'
import json,sys
rb,fb=sys.argv[1],sys.argv[2]
print(json.dumps({"containerOverrides":[{"name":"count","command":["python3","-c",rb],
  "environment":[{"name":"FHIR_BASE","value":fb}]}]}))
PY
)
TASK=$(aws ecs run-task --cluster "$STACK" --task-definition "${STACK}-count" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[${SUB1}],securityGroups=[${SG}],assignPublicIp=DISABLED}" \
  --overrides "$OVERRIDE" --region "$REGION" --profile "$PROFILE" --query 'tasks[0].taskArn' --output text)
echo "read-only count task: $TASK"
aws ecs wait tasks-stopped --cluster "$STACK" --tasks "$TASK" --region "$REGION" --profile "$PROFILE"
sleep 6
echo "=== EHR patient inventory (read-only) ==="
aws logs tail /agentops/ehr-fhir/nonprod --since 3m --region "$REGION" --profile "$PROFILE" 2>/dev/null | grep -E "PATIENT_TOTAL|PATIENT " | tail -80 || true
