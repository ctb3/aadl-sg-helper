# aadl-sg-helper

[![CI](https://github.com/ctb3/aadl-sg-helper/actions/workflows/ci.yml/badge.svg)](https://github.com/ctb3/aadl-sg-helper/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

AADL Summer Game code helper. a mobile web app that reads the handwritten
code off an AADL Summer Game yard sign from a phone photo and automatically
submits it to aadl.org. Built out of inherent laziness, to save myself
having to type in 12 characters manually.

## How it works

Runs in a Docker container in a Lambda in AWS.

1. **Tier 1 — Google Cloud Vision** on a 2400px q0.7 JPEG posted inline.
   Post-processing isolates the code line: subtract the sign's printed
   phrases, take the tallest remaining line, gate on min word confidence.
2. **Tier 2 — Claude on a crop** when the gate fails or the user rejects:
   the client cuts a high-res crop from its original photo at the line bbox
   tier 1 returned, and Claude (Bedrock) transcribes it glyph-by-glyph.
3. **Manual prefilled** — the best guess lands in an editable field, to be
   tweaked before submitting.
4. **Submit** to aadl.org for every connected account/player (or a `?text=`
   handoff link when no account is connected).

## Usage

Local dev server:

```bash
npm run app                     # serves at http://localhost:8080
```

Open it, and either connect an aadl.org account or use it credential-free.
Take/upload a sign photo → review the extracted code → submit.

Smoke-test a running deployment:

```bash
npx tsx infra/apitest.ts [url]        # free-path checks
npx tsx infra/apitest.ts --full [url] # exercises paid readers too
```

## Repo layout

```
src/app/       The app: server.ts (Lambda entrypoint, also `npm run app`
               locally), pipeline.ts (tier1/tier2), aadl.ts
               (aadl.org login/submit client), flags.ts (AppConfig feature
               flags), sessions-report.ts (telemetry rollup CLI), public/.
src/core/      Shared library: config, types, image ops, reader prompt,
               GCV post-processing, scoring, Bedrock client, readers/.
src/harness/   Bake-off / offline CLIs that proved the pipeline.
infra/         Dockerfile (Lambda image), Terraform (bootstrap + app, per
               account), apitest.ts / aadltest.ts smoke tests, deploy
               runbook in infra/README.md.
data/          Private, gitignored: images/, labels.csv, cache/, prepped/.
out/           Untracked run outputs (out/runs/<timestamp>/).
```

## Commands

| Command | What it does |
|---|---|
| `npm run app` | App server at :8080 (same code the Lambda runs) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run preflight` | One tiny call per engine to verify cloud access |
| `npm run bake` / `npm run smoke` | Bake-off matrix (full / 1-image) — see `src/harness/README.md` |
| `npm run label` | Labeler at :5178 — label new images, verify existing |
| `npx tsx src/app/sessions-report.ts [--summary]` | Field-session telemetry report (S3) |
| `npx tsx infra/apitest.ts [--full] [base-url]` | Smoke-test a deployed app (`--full` = paid path) |
| `npx tsx infra/aadltest.ts [CODE]` | Live aadl.org client test (needs test creds; a CODE really redeems) |

Harness-specific commands (offline analysis, tier-2 crop experiments, etc.):
[`src/harness/README.md`](src/harness/README.md).

## Prerequisites

1. **Node 22**
2. **AWS**: credentials via the standard chain (this project uses IAM Identity
   Center SSO profiles), region set. Bedrock model access enabled for the
   Claude reader (per-account Marketplace subscription).
3. **GCP**: a service-account JSON with the Vision API enabled;
   `GOOGLE_APPLICATION_CREDENTIALS` pointed at it (or inline via
   `GCP_SA_KEY_JSON`).

Model IDs, region, thresholds, and cost constants are set in `.env` — see
`.env.example` (full list, including harness-only knobs).

```bash
npm install
cp .env.example .env      # then fill in creds / model IDs
npm run preflight
```

### Env vars to run the app locally

| Var | Required? | Notes |
|---|---|---|
| `AWS_REGION` | yes | Bedrock/S3 region |
| `AWS_PROFILE` | if not using default creds | SSO profile name |
| `GOOGLE_APPLICATION_CREDENTIALS` | yes | path to GCP Vision service-account JSON |
| `CLAUDE_READER_MODEL` | yes | Bedrock model ID for tier 2 |
| `APP_PIN` | no | empty = no PIN gate locally |
| `SESSIONS_BUCKET` | no | set only to test S3 session logging locally |
| `PORT` | no | default 8080 |
| `AADL_BASE_URL` | no | override aadl.org origin (e.g. for a mock) |
| `EXTRACT_MODE` | no | `full` \| `gcv` \| `off` — reader circuit breaker fallback |

Everything else in `.env.example` (`APPCONFIG_*`, cost constants,
`GCV_BAND_*`, `IMAGES_DIR`, etc.) is harness-only or has a safe default.

## Deploys

CI-only: push to `main` auto-deploys the TEST account; publishing a GitHub
Release `vX.Y.Z` deploys PROD (tag must equal `package.json` version).
Runbook, Terraform layout, feature-flag flips, and rollback procedure:
[`infra/README.md`](infra/README.md).
