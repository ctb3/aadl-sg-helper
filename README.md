# aadl-sg-helper

AADL Summer Game code helper — a deployed **field-test app** that reads the
handwritten code off a Summer Game yard sign from a phone photo and submits it
to aadl.org, plus the **measurement harness** (bake-off) that proved the
extraction pipeline.

- Prod: <https://aadlcode.ctb3.net> · Test: <https://aadlcode-test.ctb3.net>
  (access gated by a shared PIN)

> Governing constraint: codes are **user-generated** — charset `[A-Z0-9]`,
> **no length limit** (signup caps new codes at 12 chars, but grandfathered
> longer codes are live; a 14-char code was redeemed in the field — never add
> a length check), no dictionary. Faithful glyph reading is the goal — the LLM
> prompt forbids "correcting" messy handwriting toward real words. There is no
> validation oracle at extraction time; ground truth comes only from
> hand-labeling (the aadl.org submission response acts as a weak oracle after
> the fact).

## The pipeline (proven by the bake-off)

1. **Tier 1 — Google Cloud Vision** on a 2400px q0.7 JPEG posted inline.
   Post-processing isolates the code line: subtract the sign's printed
   phrases, take the tallest remaining line (glyph-box heights), gate on
   min word confidence ≥ 0.5.
2. **Tier 2 — Claude on a crop** when the gate fails or the user rejects:
   the client cuts a high-res crop from its original photo at the line bbox
   tier 1 returned, and Claude (Bedrock) transcribes it glyph-by-glyph.
3. **Manual prefilled** — the best guess lands in an editable field;
   approve-before-submit is the default.
4. **Submit** to aadl.org for every connected account/player (or a `?text=`
   handoff link when no account is connected).

Measured: 97.4% end-to-end (n=39), tier-2-on-crop 95.2% (n=63), ~87% of
photos resolve instantly on tier 1 at <$0.003/img average. Details and the
full findings log live in `CLAUDE.md` and `out/runs/postproc-analysis.md`
(generated).

## Repo layout

```
src/app/       Deployed field-test app: server.ts (Lambda entrypoint, also
               `npm run app` locally), pipeline.ts (tier1/tier2), aadl.ts
               (aadl.org login/submit client), flags.ts (AppConfig feature
               flags), sessions-report.ts (telemetry rollup CLI), public/.
src/core/      Shared library: config, types, image ops, reader prompt,
               GCV post-processing, scoring, Bedrock client, readers/
               (claude, gcv — used by the app; nova, textract — bake-off
               baselines only).
src/harness/   Bake-off / offline CLIs: run (the matrix), analyze (offline
               post-proc + cascade sim), tier2 (crop experiments), label
               (browser labeler), preflight, localizer (dropped model_crop
               arm), cachekey, report.
infra/         Dockerfile (Lambda image), Terraform (bootstrap + app, per
               account), apitest.ts / aadltest.ts smoke tests, deploy
               runbook in infra/README.md.
data/          Private, gitignored: images/, labels.csv, cache/, prepped/.
out/           Untracked run outputs (out/runs/<timestamp>/).
```

## Commands

| Command | What it does |
|---|---|
| `npm run app` | Field-test app server at :8080 (same code Lambda runs) |
| `npm run label` | Labeler at :5178 — label new images, verify existing |
| `npm run smoke` | Bake-off matrix, 1 image (catches creds/model-access gaps) |
| `npm run bake` | Full bake-off over every labeled image |
| `npm run preflight` | One tiny call per engine to verify cloud access |
| `npm run typecheck` | `tsc --noEmit` |
| `npx tsx src/harness/analyze.ts` | Post-proc strategies + cascade sim, fully offline from `data/cache` (zero API calls) |
| `npx tsx src/harness/tier2.ts` | Claude on high-res crops at GCV line bboxes |
| `npx tsx src/app/sessions-report.ts [--summary]` | Field-session telemetry report (S3) |
| `npx tsx infra/apitest.ts [--full] [base-url]` | Smoke-test a deployed app (`--full` = paid path) |
| `npx tsx infra/aadltest.ts [CODE]` | Live aadl.org client test (needs test creds; a CODE really redeems) |

Bake-off filters: `npm run bake -- --reader claude|nova|textract|gcv
--arm none|model_crop --image sign01.jpg --limit 5 --force`.

Bake-off outputs land in `out/runs/<timestamp>/`: raw per-prediction JSON,
`results.csv`, and `report.md` (exact-match table, CER, confidence
calibration, latency & cost). Paid calls are cached in `data/cache/` keyed by
reader model + prompt hash + GCV input resolution/quality (see `CLAUDE.md`
caching rules); `--force` bypasses.

## The bake-off (historical, still runnable)

Four readers were compared across two preprocessing arms:

| Reader | Engine | Status |
|---|---|---|
| `gcv` | Google Cloud Vision (DOCUMENT_TEXT) | **Won tier 1** (with post-processing) |
| `claude` | Bedrock Claude (Converse, multimodal) | **Won tier 2** (on crops; full-photo fails on small signs) |
| `nova` | Bedrock Nova (Converse, multimodal) | Dropped (~65%, prompt-insensitive) |
| `textract` | AWS Textract | Dropped (strictly worse than GCV) |

Arms: `none` (downscaled full photo) and `model_crop` (paid Nova localizer
bbox → crop) — `model_crop` is obsolete: GCV's tier-1 line bbox localizes for
free and better. Dropped readers/arms stay runnable for future re-baselines.

Metrics: exact full-code match (normalized: uppercase, spaces stripped —
submission is case/space-insensitive), character error rate, confidence
calibration (does low confidence predict errors?).

## Prerequisites

1. **Node 22** (matches CI).
2. **AWS**: credentials via the standard chain (this project uses IAM Identity
   Center SSO profiles), region set. Bedrock model access enabled for the
   Claude reader (per-account Marketplace subscription); Textract only if you
   re-run that baseline.
3. **GCP**: a service-account JSON with the Vision API enabled;
   `GOOGLE_APPLICATION_CREDENTIALS` pointed at it (or inline via
   `GCP_SA_KEY_JSON`).
4. Images in `data/images/` (or point `IMAGES_DIR` elsewhere) for the harness.

Model IDs, region, thresholds, and cost constants are set in `.env` — see
`.env.example`.

```bash
npm install
cp .env.example .env      # then fill in creds / model IDs
npm run preflight
```

## Deploys

CI-only: push to `main` auto-deploys the TEST account; publishing a GitHub
Release `vX.Y.Z` deploys PROD (tag must equal `package.json` version).
Runbook, Terraform layout, feature-flag flips, and rollback procedure:
[`infra/README.md`](infra/README.md).
