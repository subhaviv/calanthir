#!/usr/bin/env bash
#
# Deploy the standalone HAPI FHIR EHR supporting stack to agentops-publisher.
# This stack SUPPORTS the Agentic AI Platform blueprint but is not part of any
# agent's own infrastructure. Run from this directory.
#
#   cd enterprise-mcp-governance-gateway/infra/ehr-fhir
#   ./deploy.sh
#
set -euo pipefail

STACK=agentops-ehr-fhir-nonprod
REGION=us-east-1
PROFILE=agentops-publisher
TEMPLATE=ehr-fhir.cfn.yaml
SECRET_NAME="agentops/ehr-fhir/nonprod-db"

cd "$(dirname "$0")"

echo ">> Validating template..."
aws cloudformation validate-template \
  --template-body "file://${TEMPLATE}" \
  --region "$REGION" --profile "$PROFILE" >/dev/null
echo "   ok"

# A stack left in ROLLBACK_COMPLETE / *_FAILED cannot be updated or deployed over -
# it must be deleted first. Handle that so re-runs are a single command.
STATUS=$(aws cloudformation describe-stacks --stack-name "$STACK" \
          --region "$REGION" --profile "$PROFILE" \
          --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "NONE")
case "$STATUS" in
  ROLLBACK_COMPLETE|CREATE_FAILED|ROLLBACK_FAILED|UPDATE_ROLLBACK_FAILED|DELETE_FAILED)
    echo ">> Stack is in ${STATUS}; deleting before re-deploy..."
    aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION" --profile "$PROFILE"
    aws cloudformation wait stack-delete-complete --stack-name "$STACK" --region "$REGION" --profile "$PROFILE"
    echo "   deleted"
    ;;
  *_IN_PROGRESS)
    echo ">> Stack is ${STATUS}; waiting for it to settle before proceeding..."
    aws cloudformation wait stack-rollback-complete --stack-name "$STACK" --region "$REGION" --profile "$PROFILE" 2>/dev/null || true
    aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION" --profile "$PROFILE" 2>/dev/null || true
    aws cloudformation wait stack-delete-complete --stack-name "$STACK" --region "$REGION" --profile "$PROFILE" 2>/dev/null || true
    ;;
esac

# Generate a strong DB password (>=12 chars) unless one already lives in Secrets Manager.
if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" \
      --region "$REGION" --profile "$PROFILE" >/dev/null 2>&1; then
  echo ">> Reusing existing DB secret ${SECRET_NAME}"
  DBPW=$(aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" \
          --region "$REGION" --profile "$PROFILE" \
          --query SecretString --output text | python3 -c "import sys,json;print(json.load(sys.stdin)['password'])")
else
  echo ">> Generating DB password and storing it in Secrets Manager (${SECRET_NAME})"
  DBPW=$(python3 -c "import secrets,string; print(''.join(secrets.choice(string.ascii_letters+string.digits) for _ in range(24)))")
  aws secretsmanager create-secret \
    --name "$SECRET_NAME" \
    --secret-string "{\"username\":\"hapi\",\"password\":\"${DBPW}\",\"dbname\":\"hapi\"}" \
    --region "$REGION" --profile "$PROFILE" >/dev/null
fi

echo ">> Deploying ${STACK} (RDS is the long pole; expect ~8-12 min)..."
aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file "$TEMPLATE" \
  --parameter-overrides "DbPassword=${DBPW}" \
  --capabilities CAPABILITY_IAM \
  --region "$REGION" --profile "$PROFILE"

echo ">> Stack outputs:"
aws cloudformation describe-stacks \
  --stack-name "$STACK" \
  --region "$REGION" --profile "$PROFILE" \
  --query 'Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue}' \
  --output table

echo ""
echo ">> Done. The FHIR server may take a few more minutes to pass ALB health checks"
echo "   (first boot runs a Postgres schema migration). Check with:"
echo "   aws ecs describe-services --cluster ${STACK} --services ${STACK} --region ${REGION} --profile ${PROFILE} --query 'services[0].{running:runningCount,desired:desiredCount}'"
