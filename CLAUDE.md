# AADL Summer Game — handwriting-extraction bake-off

Measurement harness (not the app — yet) for extracting the handwritten code
from AADL Summer Game yard-sign photos.

## End goal (the app this is building toward)

Mobile website on AWS. Target UX: walk up to a sign → tap to open the camera →
take a picture → the app extracts the code using the pipeline proven here
(GCV gated → Claude-on-crop → manual prefilled) → auto-submits the code to
play.aadl.org for the user's account(s) — multiple accounts per user (e.g.
family) should each get the code.

Auth story (resolved in v0.2.1, see src/app/aadl.ts): the game is a Drupal 10
form on aadl.org (play.aadl.org just redirects; module source is public at
github.com/aadl/summergame). No credential is ever stored server-side: the
client sends username/password once to /api/aadl/connect, the Lambda performs
the Drupal login (persistent_login=1) and hands the cookie jar back to the
phone (localStorage); /api/submit replays those cookies. One account can hold
many players — the redeem form's pids[] checkboxes get all of them in one
POST. Zero-credential fallback: aadl.org/summergame/player/0/gamecode?text=CODE
prefills the form for the user's own browser session (AADL's QR flow).
The submission response IS the validation oracle: "Code is not recognized"
(traceless server-side — no ledger row, doesn't count against the rate limit)
triggers tier-2 escalation; "already redeemed" confirms a correct read. Only
real risk: a misread colliding with a *different* valid code awards wrong
points — why approve-before-submit stays the default (full-auto is a client
toggle, default off).

## The one governing constraint

Codes are USER-GENERATED: `[A-Z0-9]`, arbitrary — no dictionary, no word
priors, and NO length limit: signup caps new codes at 12 chars, but
grandfathered longer ones are live (HOTLIKEHARISSA, 14, redeemed 2026-07-05) —
never (re)add a length check anywhere (removed from app+prompt in v0.3.2).
Never let an LLM "correct" toward a real word; prompts must demand
literal glyph-by-glyph transcription (see `src/prompt.ts`). There is no
validation oracle — ground truth is hand labels only (`data/labels.csv`).
Scoring normalizes case/whitespace (submission is case/space-insensitive).

## Commands

- `npm run label` — labeler at :5178; labels new images, then a verify pass
  over existing labels (session-scoped).
- `npm run bake` / `npm run smoke` — the matrix. Flags via `src/run.ts`:
  `--reader claude|nova|textract|gcv`, `--arm none|model_crop`, `--image`,
  `--limit`, `--force`. Writes `out/runs/<ts>/{report.md,results.csv}`.
- `npx tsx src/analyze.ts` — post-processing strategies + cascade simulation,
  entirely offline from `data/cache` (zero API calls, free to iterate).
- `npx tsx src/tier2.ts` — Claude on a high-res crop at GCV's chosen-line bbox.
- `npm run preflight` / `npm run typecheck`.
- `npm run app` — field-test app server at :8080 (same code Lambda runs);
  `npx tsx infra/apitest.ts [--full] [base-url]` smoke-tests it (`--full` = paid
  path; base URL must have NO trailing slash; pass the PIN with
  `WSLENV=APP_PIN/w APP_PIN=…` — a plain env prefix dies at the WSL→Windows
  boundary and dotenv silently substitutes .env's pin).
- Deploys are CI-only (`.github/workflows/`, runbook in `infra/README.md`):
  push to main → TEST account auto-deploy; publish GitHub Release vX.Y.Z →
  PROD (tag must equal package.json version — bump it in the PR). Rollback =
  re-dispatch deploy-prod from the old tag (immutable ECR tags skip rebuild).
- `npx tsx infra/aadltest.ts [CODE]` — live integration test of the aadl.org
  client (login/connect/gibberish-submit; needs AADL_USERNAME/AADL_PASSWORD
  test creds in .env). Pass a CODE to exercise the success path — it REALLY
  redeems it on the test account (repeat runs verify via already_redeemed).

## Field-test app (src/app + infra)

v0.2 app: photo → tier-1 GCV (no spatial band; gate minConf≥0.5) → approve/
reject → tier-2 Claude on the GCV-line crop → manual prefilled → submit to
aadl.org for every connected account/player (or the ?text= handoff link when
none is connected). Rejected submits offer/auto-run tier-2 escalation
(submit.json logs each attempt per session, cookie-free; verdict.json and
submit.json stay separate so extraction accuracy and submission health are
independently attributable). Client uploads full-res JPEG straight to S3 via presigned PUT
(dodges the 6MB Function URL cap, keeps tier-2 crops high-res); every session
logs photo/crop/results/verdicts under s3://aadl-sg-sessions-…/sessions/ for
future labeling. Access gate = APP_PIN (.env) checked server-side.
Image storage is behind the `store-images` AppConfig feature flag (runtime,
per-account, flip without redeploy — src/app/flags.ts, infra/README.md; default
ON). When OFF the transport forks: the client posts the photo inline (and the
crop back on escalate) so NO image bytes ever hit S3 — only the telemetry JSON
is kept, so accuracy/speed reporting is unaffected. `sessions-report.ts
--summary` is the cross-version rollup (per version: seen, tier1/tier2 correct
rates, gate%, per-step avg·p99); the default (no flag / a prefix arg) stays the
single-version detail view. Telemetry lives in the per-session JSON (durable
event log; summary computed on read) — never gated by the flag.
Versioning is tag-driven: prod ships package.json's version verbatim (CI
asserts tag == version); test builds stamp `X.Y.Z-test.<run>.<attempt>.g<sha>`
via a Dockerfile ARG. The version shows on the page, prefixes sessions
(`sessions/v<version>/`), lands in extract.json; sessions-report.ts defaults
to the current version's prefix. GET / is `Cache-Control: no-store` — a
phone-cached stale client once silently dropped a batch's instrumentation.
Accounts (us-east-2, Terraform in infra/terraform/, OIDC from GitHub — no
long-lived keys): TEST 825555019530, PROD 766253192238; old account
619467956318 was torn down 2026-07-05. Secrets (APP_PIN, GCV key) live in
each account's SSM under /aadl-sg/.
Custom domains (v0.4.0): prod https://aadlcode.ctb3.net, test
https://aadlcode-test.ctb3.net — CloudFront in front of the Function URL
(which stays public as a debugging bypass; PIN gates both). Per-env hosted
zone in bootstrap, delegated from ctb3.net (ctb3-general account, manual
one-time NS record — redo it if the zone is ever recreated). CloudFront must
NOT forward the viewer Host header (Function URLs route by Host — the
AllViewerExceptHostHeader managed policy handles it); origin read timeout is
60s (max without a quota bump). No OAC: SigV4 origins force browsers to send
x-amz-content-sha256 on POSTs.
Gotchas burned in already: Lambda rejects BuildKit attestation manifests
(build with --provenance=false --sbom=false); the Function URL needs a
public lambda:InvokeFunction grant besides InvokeFunctionUrl (PIN still holds
either way); the Function URL + its two permissions must apply serially
(concurrent AddPermission → 409); GitHub jobs with `environment:` present
OIDC sub `repo:…:environment:<name>` not `ref:…` (CI-role trust accepts
both); Android Chrome throttles main-thread canvas work after returning
from the camera app (constant ~13.4s toBlob stall) — client encodes in a
Web Worker via OffscreenCanvas (main-thread fallback kept).

## Caching rules (read before re-running anything)

- `data/cache` keys include reader model, reader-prompt hash, and GCV input
  resolution (`src/cachekey.ts`) — editing `prompt.ts` or models auto-invalidates.
- Only successful results are cached; errors retry on re-run.
- NOT keyed by image content: if files in `data/images` change under the same
  filename, wipe `data/prepped` and `data/cache` by hand.
- Photos and labels are private → gitignored (`data/images`, `data/labels.csv`,
  `data/manual cropped`). `out/` is also untracked; findings live in commit
  messages and `out/runs/postproc-analysis.md`.

## Findings so far (don't re-derive)

39 raw-framing photos, `none` arm. Best pipeline: **GCV 2400px + phrase
subtraction + tallest-line + minConf≥0.5 gate → Claude on GCV-line crop →
manual prefilled** = 97.4% end-to-end, <$0.003/img avg, 87% instant (0.4s).

- GCV reads fine, isolates badly: post-processing (`src/postproc.ts`) took it
  0%→87%. Both signals required — height alone ~54%, phrase alone ~5%.
- Line heights must come from glyph/symbol boxes; axis-aligned boxes around
  tilted words or curved ring text are inflated (why Textract LINE blocks fail).
- Textract: HANDWRITING tag useless here (marker block-caps tagged PRINTED);
  with post-processing still strictly worse than GCV. Dropped from pipeline.
- Nova ≈65%, prompt-insensitive; dropped. `model_crop` arm (paid Nova localizer)
  obsolete — GCV's tier-1 line bbox localizes for free and better.
- Claude full-photo fails when the sign is small in frame (1500px downscale →
  tiny glyphs); the GCV-line crop fixed every such miss.
- Known open failure: scene text — GCV once picked a house number at 0.99 conf,
  so confidence does NOT gate localization errors. Idea if it recurs: require
  the chosen line to sit spatially among the phrase-matched printed lines.
- Prompt-hardening that worked (in-sample): doodles-aren't-letters, ignore
  ghost strokes of cleaned-off codes, resolve ambiguous glyphs by the writer's
  own letterforms. Caveat everywhere: n=39, thresholds tuned while looking.

## Environment (WSL + Windows)

- `npm`/`npx tsx` run **Windows** node (`node` isn't on WSL PATH). Paths in
  output are `C:\...`. WSL `curl` cannot reach Windows-node localhost ports;
  test servers from the Windows browser.
- Orphaned listeners (e.g. labeler on :5178): find via `netstat.exe -ano |
  grep :5178`, verify+kill via `powershell.exe -Command "Stop-Process -Id <pid>
  -Force"`. Stopping the WSL background task does not kill the Windows process.
- AWS: one shared `~/.aws` (WSL's is a symlink to Windows'), region
  `us-east-2`. IAM Identity Center SSO profiles: `aadl-sg-test-admin` /
  `aadl-sg-prod-admin` (`.env` sets AWS_PROFILE=aadl-sg-test-admin — local
  work targets the TEST account). When the SSO session expires, run
  `aws sso login` from **Windows/PowerShell** for the harness (npx = Windows
  node reads the Windows-side token cache). Bedrock models need per-model
  per-account Marketplace subscription (Sonnet 4.6 enabled in both accounts).
- Temp scripts must live inside the project — cross-drive tsx imports fail.
