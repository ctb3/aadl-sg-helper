#!/usr/bin/env bash
# Deploys the field-test app: container image -> Lambda (Web Adapter) behind a
# public Function URL, plus the private sessions bucket and a scoped execution
# role. Idempotent — run it again to ship a new image or config.
#
# Runs from WSL using the WINDOWS docker.exe + aws.exe (see CLAUDE.md): both
# resolve relative paths against the mapped C:\ cwd, so everything here stays
# relative to the repo root.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${DEPLOY_AWS_PROFILE:-service-aadl-sg-helper}"
REGION="${DEPLOY_AWS_REGION:-us-east-2}"
FN="${APP_FUNCTION_NAME:-aadl-sg-app}"
REPO="$FN"
ROLE="$FN-role"

aws()  { aws.exe --profile "$PROFILE" --region "$REGION" "$@"; }
awst() { aws --output text "$@" | tr -d '\r'; }

ACCOUNT=$(awst sts get-caller-identity --query Account)
# .env can override the bucket; parsed with grep because sourcing .env in bash
# would mangle the Windows backslash paths in it.
BUCKET=$(grep -E '^SESSIONS_BUCKET=.+' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' || true)
BUCKET="${BUCKET:-aadl-sg-sessions-$ACCOUNT}"
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
IMAGE="$REGISTRY/$REPO:latest"

echo "== $FN -> account $ACCOUNT ($REGION), bucket $BUCKET"

echo "== generating env + role policy from .env"
npx tsx infra/mkenv.ts "$BUCKET"

echo "== sessions bucket"
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3api create-bucket --bucket "$BUCKET" \
    --create-bucket-configuration "LocationConstraint=$REGION"
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration file://infra/s3-cors.json

echo "== execution role"
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document file://infra/lambda-trust.json >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "   created $ROLE, waiting for IAM propagation"
  sleep 12
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name app-access \
  --policy-document file://infra/.role-policy.json
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE"

echo "== image build + push"
aws ecr describe-repositories --repository-names "$REPO" >/dev/null 2>&1 ||
  aws ecr create-repository --repository-name "$REPO" >/dev/null
# Lambda (the service) pulls the image itself; the repo policy must allow it.
sed "s/619467956318/$ACCOUNT/g; s/us-east-2/$REGION/g" infra/ecr-repo-policy.json \
  > infra/.ecr-repo-policy.json
aws ecr set-repository-policy --repository-name "$REPO" \
  --policy-text file://infra/.ecr-repo-policy.json >/dev/null
awst ecr get-login-password | docker.exe login --username AWS --password-stdin "$REGISTRY"
# --provenance/--sbom=false: BuildKit attestations create an OCI image index,
# which Lambda's CreateFunction rejects; it needs a single-platform manifest.
docker.exe buildx build --platform linux/amd64 --provenance=false --sbom=false \
  -f infra/Dockerfile -t "$IMAGE" --push .

echo "== lambda"
if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN" --image-uri "$IMAGE" >/dev/null
  aws lambda wait function-updated --function-name "$FN"
  aws lambda update-function-configuration --function-name "$FN" \
    --timeout 120 --memory-size 2048 --environment file://infra/.lambda-env.json >/dev/null
  aws lambda wait function-updated --function-name "$FN"
else
  for attempt in 1 2 3 4 5; do
    if aws lambda create-function --function-name "$FN" --package-type Image \
      --code "ImageUri=$IMAGE" --role "$ROLE_ARN" --architectures x86_64 \
      --timeout 120 --memory-size 2048 \
      --environment file://infra/.lambda-env.json >/dev/null; then
      break
    fi
    echo "   create-function failed (IAM propagation?), retry $attempt"
    sleep 10
  done
  aws lambda wait function-active --function-name "$FN"
fi

echo "== public function URL (the PIN is the gate)"
aws lambda create-function-url-config --function-name "$FN" --auth-type NONE >/dev/null 2>&1 || true
aws lambda add-permission --function-name "$FN" --statement-id public-url \
  --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE \
  >/dev/null 2>&1 || true
# InvokeFunctionUrl alone still 403s in this account; the URL front-end also
# wants a public lambda:InvokeFunction grant. (PIN auth is inside the server,
# so this does not widen actual access to the API.)
aws lambda add-permission --function-name "$FN" --statement-id public-invoke \
  --action lambda:InvokeFunction --principal '*' \
  >/dev/null 2>&1 || true

URL=$(awst lambda get-function-url-config --function-name "$FN" --query FunctionUrl)
echo ""
echo "deployed: $URL"
