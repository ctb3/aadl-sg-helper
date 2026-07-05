# Deploys: GitHub Actions + Terraform

- **Push to `main`** → deploys the **test** account (825555019530) via `.github/workflows/deploy-test.yml`, version stamped `X.Y.Z-test.<run>.<attempt>.g<sha>`.
- **Publish a GitHub Release `vX.Y.Z`** → deploys the **prod** account (766253192238) via `deploy-prod.yml`. Publishing the release IS the approval gate. The tag must equal `package.json`'s version (bump it in the PR).
- PRs run `ci.yml` only (typecheck + terraform fmt/validate) — no AWS access.
- **Rollback prod:** Actions → deploy-prod → Run workflow → pick the old `vX.Y.Z` **tag** as the ref. The image already exists in ECR (immutable tags), so the build is skipped and the Lambda repoints to the exact prior artifact.

Auth is GitHub OIDC → per-account role `aadl-sg-ci`. The test account's role trusts only `refs/heads/main`; prod's only `refs/tags/v*` — a main push cannot reach prod. No long-lived AWS keys exist anywhere.

Stacks (`infra/terraform/`):

- `bootstrap/` — Carl-only, admin SSO profile, once per account: TF state bucket, OIDC provider, `aadl-sg-ci` role + `aadl-sg-app-boundary` permissions boundary, ECR repo (immutable tags).
- `app/` — applied by CI: sessions bucket, Lambda exec role (under the boundary), the Lambda + public Function URL. Secrets are read from SSM at deploy time.

## One-time bootstrap runbook (Carl, admin, per account)

1. **Access:** IAM Identity Center in the Organization, AdministratorAccess
   permission set assigned to both accounts; `aws configure sso` → profiles
   `aadl-sg-test-admin` / `aadl-sg-prod-admin`. Install terraform ≥ 1.10 **in
   WSL** (linux binary — the committed `.terraform.lock.hcl` is linux_amd64).

2. **Bedrock model access** (fresh accounts have none): in each account,
   Bedrock console → Model access, us-east-2 → enable Anthropic Claude
   (the model in `infra/terraform/app/*.tfvars`, currently Sonnet 4.6).
   Per-account Marketplace subscription — same gotcha CLAUDE.md records.

3. **SSM parameters** in each account (us-east-2). Different PIN per env;
   prefix the commands with a space to keep them out of shell history:

   ```bash
    aws ssm put-parameter --name /aadl-sg/app-pin --type SecureString --value '<PIN>'
    aws ssm put-parameter --name /aadl-sg/gcp-sa-key --type SecureString \
      --value "$(jq -c . < /path/to/gcv-service-account.json)"
   ```

   The same GCP key in both accounts is fine (mint a second GCP SA key for
   test if you want blast separation on the Google side too).

4. **Bootstrap apply** (per account). The backend is partial — every
   terraform command needs `AWS_PROFILE` set (the S3 backend reads the
   ambient credential chain, not the provider block), and every `init`
   names the account's state bucket explicitly. Create the bucket first,
   import it, then apply:

   ```bash
   cd infra/terraform/bootstrap
   export AWS_PROFILE=aadl-sg-test-admin   # or aadl-sg-prod-admin
   ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
   aws s3api create-bucket --bucket "aadl-sg-tf-state-$ACCOUNT" --region us-east-2 \
     --create-bucket-configuration LocationConstraint=us-east-2
   terraform init -reconfigure \
     -backend-config="bucket=aadl-sg-tf-state-$ACCOUNT" -backend-config="region=us-east-2"
   terraform import -var-file=test.tfvars aws_s3_bucket.tf_state "aadl-sg-tf-state-$ACCOUNT"
   terraform apply -var-file=test.tfvars   # prod.tfvars for prod
   ```

   (`-reconfigure` matters when switching this working dir between
   accounts.) Note outputs `ci_role_arn` / `state_bucket`.

5. **GitHub:** repo → Settings → Environments → create `test` and `prod`.
   In each, add variables `AWS_ROLE_ARN` and `TF_STATE_BUCKET` from that
   account's bootstrap outputs. Repo-level variable: `AWS_REGION=us-east-2`.

First test deploy = next push to main. Verify with the paid path once:
`APP_PIN=<test-pin> npx tsx infra/apitest.ts --full https://<test-url>`.

## Cutover from the old account (619467956318)

Old stack keeps serving until the new prod URL is verified. **Nothing in the
old account gets deleted until Carl explicitly approves.** Then:

1. Sync session history into new prod (two steps via local disk — avoids
   cross-account bucket policies):

   ```bash
   aws s3 sync s3://aadl-sg-sessions-619467956318/sessions/ ./sessions-archive/ \
     --profile service-aadl-sg-helper
   aws s3 sync ./sessions-archive/ s3://aadl-sg-sessions-766253192238/sessions/ \
     --profile aadl-sg-prod-admin
   ```

2. Move the phone bookmark to the new prod Function URL.
3. Tear down old resources (Lambda, role, ECR, buckets, deploy user
   `service-aadl-sg-helper`); retire the account when comfortable.

## Local escape hatch (CI down / debugging)

Same commands CI runs, with an admin SSO profile: docker build+push an
immutable tag, then `terraform -chdir=infra/terraform/app init -backend-config
bucket/region` + `apply -var-file=<env>.tfvars -var image_uri=...`.
`npx tsx infra/apitest.ts [--full] <url>` smoke-tests any deployment.
