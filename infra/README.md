# Deploys: GitHub Actions + Terraform

- **Push to `main`** → deploys the **test** account (825555019530) via `.github/workflows/deploy-test.yml`, version stamped `X.Y.Z-test.<run>.<attempt>.g<sha>`.
- **Publish a GitHub Release `vX.Y.Z`** → deploys the **prod** account (766253192238) via `deploy-prod.yml`. Publishing the release IS the approval gate. The tag must equal `package.json`'s version (bump it in the PR).
- PRs run `ci.yml` only (typecheck + terraform fmt/validate) — no AWS access.
- **Rollback prod:** Actions → deploy-prod → Run workflow → pick the old `vX.Y.Z` **tag** as the ref. The image already exists in ECR (immutable tags), so the build is skipped and the Lambda repoints to the exact prior artifact.

Auth is GitHub OIDC → per-account role `aadl-sg-ci`. The test account's role trusts only `refs/heads/main`; prod's only `refs/tags/v*` — a main push cannot reach prod. No long-lived AWS keys exist anywhere.

Stacks (`infra/terraform/`):

- `bootstrap/` — Carl-only, admin SSO profile, once per account: TF state bucket, OIDC provider, `aadl-sg-ci` role + `aadl-sg-app-boundary` permissions boundary, ECR repo (immutable tags), the app-domain hosted zone.
- `app/` — applied by CI: sessions bucket, Lambda exec role (under the boundary), the Lambda + public Function URL, ACM cert + CloudFront + DNS records for the custom domain, and the **AppConfig feature-flag stack** (`appconfig.tf`). Secrets never leave SSM until runtime: the Lambda env carries parameter *names*, and the app fetches the values at cold start (`src/app/secrets.ts`) — nothing secret lands in TF state or `lambda:GetFunctionConfiguration`. Feature flags are also read at *runtime* (see below).

The app answers at a custom domain per env — **prod `https://aadlcode.ctb3.net`, test `https://aadlcode-test.ctb3.net`** — via CloudFront in front of the Function URL. The raw Function URL (`terraform output function_url`) keeps working as a debugging bypass. The app is public — no access gate (the `extract-mode` flag is the cost circuit breaker).

## One-time bootstrap runbook (Carl, admin, per account)

1. **Access:** IAM Identity Center in the Organization, AdministratorAccess
   permission set assigned to both accounts; `aws configure sso` → profiles
   `aadl-sg-test-admin` / `aadl-sg-prod-admin`. Install terraform ≥ 1.10 **in
   WSL** (linux binary — the committed `.terraform.lock.hcl` is linux_amd64).

2. **Bedrock model access** (fresh accounts have none): in each account,
   Bedrock console → Model access, us-east-2 → enable Anthropic Claude
   (the model in `infra/terraform/app/*.tfvars`, currently Sonnet 4.6).
   Per-account Marketplace subscription — same gotcha CLAUDE.md records.

3. **SSM parameter** in each account (us-east-2). Prefix the command with a
   space to keep it out of shell history:

   ```bash
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

5. **Domain delegation** (after the bootstrap apply created the env's
   hosted zone). The parent `ctb3.net` zone lives in the ctb3-general
   account (zone `Z0706371KFT1MO0MMRGV`), outside this repo. Delegate the
   env's subdomain to the new zone **before the first app deploy** — ACM
   DNS validation resolves from the public root and the apply fails after
   15 minutes without it. Don't query the new name before delegating
   (NXDOMAIN gets negatively cached for the SOA TTL).

   ```bash
   terraform output app_zone_id            # → zone_id in infra/terraform/app/<env>.tfvars
   terraform output app_zone_name_servers  # → the 4 NS values below
   AWS_PROFILE=ctb3-general-admin aws route53 change-resource-record-sets \
     --hosted-zone-id Z0706371KFT1MO0MMRGV --change-batch '{"Changes":[{
       "Action":"UPSERT","ResourceRecordSet":{"Name":"aadlcode-test.ctb3.net",
       "Type":"NS","TTL":3600,"ResourceRecords":[{"Value":"<ns1>"},
       {"Value":"<ns2>"},{"Value":"<ns3>"},{"Value":"<ns4>"}]}}]}'
   ```

   Gotchas: if the bootstrap zone is ever destroyed/recreated it gets a NEW
   name-server set — redo this delegation. If a CAA record is ever added to
   `ctb3.net`, it must permit `amazon.com` or ACM renewals silently stall
   (none exists today).

6. **GitHub:** repo → Settings → Environments → create `test` and `prod`.
   In each, add variables `AWS_ROLE_ARN` and `TF_STATE_BUCKET` from that
   account's bootstrap outputs. Repo-level variable: `AWS_REGION=us-east-2`.

First test deploy = next push to main. Verify with the paid path once:
`npx tsx infra/apitest.ts --full https://aadlcode-test.ctb3.net`.

> Migration note: the old account (619467956318) was fully torn down
> 2026-07-05 after its session data was synced into the prod bucket.

## Feature flags (AppConfig) — flip without a deploy

Runtime flags live in an AppConfig **feature-flags** profile (`app=aadl-sg`,
`env=test|prod`, `profile=flags`), read by the Lambda via `appconfigdata`
(`src/app/flags.ts`). Terraform seeds them and does the initial deploy, but
**flips happen out of band** (`ignore_changes` keeps `apply` from reverting
them). A change propagates within ~60s (the flag cache TTL) — no redeploy.
Each account is independent, so test and prod toggle separately.

- **`store-images`** (default ON): persist the session photo/crop to S3. When
  OFF, images never touch S3 (the client posts them inline; the server keeps
  only the telemetry JSON) — so accuracy/speed reporting is unaffected either
  way. See `src/app/sessions-report.ts --summary` for the cross-version rollup.
- **`extract-mode`** (default enabled, `mode=full`): the reader cost circuit
  breaker. One flag, not two booleans, because Claude-without-GCV is not a
  valid state (tier 2 reads GCV's chosen-line crop).
  - enabled + `mode=full` — normal: GCV tier 1, Claude tier-2 escalation.
  - enabled + `mode=gcv` — Claude off: gate failures, "Try harder", and
    AADL-rejected reads all land on the manual screen with the tier-1 read
    prefilled. Use this if GCV alone proves good enough.
  - **disabled** — reading fully off: the client skips upload+extract after
    the photo (nothing billable) and shows a "sorry, reading is switched off"
    note over manual entry (their own photo displayed for reference);
    account submission and the aadl.org handoff keep working.
  - Env fallback `EXTRACT_MODE` (local dev / AppConfig unreachable / flag
    absent): defaults to `full`.

Flips deploy with the custom **`aadl-sg-flip`** strategy (100% at once, zero
bake) — instant and immediately re-flippable, unlike `AppConfig.AllAtOnce`'s
10-minute bake window that locks the environment between flips.

**Flip it — console (simplest):** AppConfig → Applications → `aadl-sg` →
Configuration profiles → `flags` → edit the flag's value (enabled on/off,
`mode` attribute for `extract-mode`) → save a new version → **Start
deployment** to the env with the `aadl-sg-flip` strategy.

**Flip it — CLI:**

> A hosted configuration version replaces the **whole document** — always
> include *every* flag (a flag you omit vanishes and the app falls back to its
> env default). Corollary of the seed's `ignore_changes`: flags added to
> `appconfig.tf` later never reach an already-deployed stack via `apply`; they
> materialize with the first out-of-band flip like this one (until then the
> absent flag fails open to its env default).

```bash
export AWS_PROFILE=aadl-sg-prod-admin   # or aadl-sg-test-admin
APP=$(aws appconfig list-applications --query "Items[?Name=='aadl-sg'].Id" --output text)
ENV=$(aws appconfig list-environments --application-id "$APP" --query "Items[0].Id" --output text)
PROF=$(aws appconfig list-configuration-profiles --application-id "$APP" --query "Items[?Name=='flags'].Id" --output text)
STRAT=$(aws appconfig list-deployment-strategies --query "Items[?Name=='aadl-sg-flip'].Id" --output text)
# The full document — edit the values you want to flip:
#   store-images enabled:false        → stop persisting images
#   extract-mode mode:"gcv"           → Claude off, GCV only
#   extract-mode enabled:false        → no automatic reading at all
cat > /tmp/flag.json <<'EOF'
{"version":"1",
 "flags":{"store-images":{"name":"store-images"},
          "extract-mode":{"name":"extract-mode",
            "attributes":{"mode":{"constraints":{"type":"string","enum":["full","gcv"]}}}}},
 "values":{"store-images":{"enabled":true},
           "extract-mode":{"enabled":true,"mode":"full"}}}
EOF
VER=$(aws appconfig create-hosted-configuration-version --application-id "$APP" \
  --configuration-profile-id "$PROF" --content-type application/json \
  --content fileb:///tmp/flag.json --query VersionNumber --output text /tmp/appconfig-ver.json)
aws appconfig start-deployment --application-id "$APP" --environment-id "$ENV" \
  --configuration-profile-id "$PROF" --configuration-version "$VER" \
  --deployment-strategy-id "$STRAT"
```

> **Bootstrap re-apply required (one-time, per account):** this feature added
> AppConfig read actions to the `aadl-sg-app-boundary` and AppConfig management
> actions to the `aadl-sg-ci` role — both in `bootstrap/`. Re-apply the
> bootstrap stack (admin SSO, per account) **before** the app deploy that first
> creates the AppConfig stack, or CI's `apply` hits AccessDenied and the runtime
> flag read silently fails-open to storing.

> **Bootstrap re-apply required (one-time, per account):** the /dash dashboard
> (v1.2.0) added `s3:ListBucket` (prefix-scoped to `sessions/*`) to the
> `aadl-sg-app-boundary`. Re-apply the bootstrap stack (admin SSO, per account)
> **before** the v1.2.0 app deploy — the boundary caps the exec role, so
> without it /api/dash-stats gets AccessDenied on ListObjectsV2 even after the
> app stack grants it.

## Local escape hatch (CI down / debugging)

Same commands CI runs, with an admin SSO profile: docker build+push an
immutable tag, then `terraform -chdir=infra/terraform/app init -backend-config
bucket/region` + `apply -var-file=<env>.tfvars -var image_uri=...`.
`npx tsx infra/apitest.ts [--full] <url>` smoke-tests any deployment
(no trailing slash on the URL; apitest runs on Windows node).
