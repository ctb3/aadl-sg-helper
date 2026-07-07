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
literal glyph-by-glyph transcription (see `src/core/prompt.ts`). There is no
validation oracle — ground truth is hand labels only (`data/labels.csv`).
Scoring normalizes case/whitespace (submission is case/space-insensitive).

## Commands

- `npm run label` — labeler at :5178; labels new images, then a verify pass
  over existing labels (session-scoped).
- `npm run bake` / `npm run smoke` — the matrix. Flags via `src/harness/run.ts`:
  `--reader claude|nova|textract|gcv`, `--arm none|model_crop`, `--image`,
  `--limit`, `--force`. Writes `out/runs/<ts>/{report.md,results.csv}`.
- `npx tsx src/harness/analyze.ts` — post-processing strategies + cascade simulation,
  entirely offline from `data/cache` (zero API calls, free to iterate).
- `npx tsx src/harness/tier2.ts` — Claude on a high-res crop at GCV's chosen-line bbox.
- `npm run preflight` / `npm run typecheck`.
- `npm run app` — field-test app server at :8080 (same code Lambda runs);
  `npx tsx infra/apitest.ts [--full] [base-url]` smoke-tests it (`--full` = paid
  path; base URL must have NO trailing slash).
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
independently attributable). Transport (v0.5 speed push): the client posts a
2400px q0.7 JPEG INLINE in /api/extract (one network pass; GCV starts on
arrival; server persists photo.jpg overlapped with GCV when store-images is
on — client echoes the session's verdict as `keep`). Tier-2 crops are cut by
the CLIENT from its local ORIGINAL photo at the bbox extract returns (the
server never auto-runs tier 2 and never ships a crop payload; gate-fail
escalation is the client calling /api/escalate with its crop — 95.2% vs 92.1%
from upload-res crops, n=63). The old presigned-PUT + server-S3-GET transport
was removed in 1.0.0 (images are inline-only). The busy screen
names the slow step (v0.5.2): /api/extract and /api/escalate go over XHR so
upload progress is visible ("Uploading photo… NN%"), and every phase arms a
4s stall watchdog that adds a second line (weak signal vs slow read vs slow
aadl.org) — field spikes were unattributable from the phone before this. GCV calls are hedged
(src/core/readers/gcv.ts, GCV_HEDGE_MS default 1500, ≤0 disables): GCV showed 6-30s
service-side latency spikes in the field, and a duplicate $0.0015 attempt —
fired only when the first is slow — caps that tail. Hedge outcome (fired,
winner) is logged in tier1.raw.rawResponse.hedge when it fires; a winner far
above the threshold = both attempts slow = correlated Google-side episode
(2026-07-06 evening prod batch: 10/13 sessions 3.3-20s, hedge active —
confirmed external, uncappable; healthy batches same day p50 ~390ms).
`src/harness/gcvprobe.ts` is the standalone latency probe (gRPC vs REST,
paid, no hedge). Every kept session
logs photo/crop/results/verdicts under s3://aadl-sg-sessions-…/sessions/ for
future labeling. The app is PUBLIC as of 1.0.0 (the APP_PIN gate was removed;
the `extract-mode` flag is the cost circuit breaker).
Image storage is behind the `store-images` AppConfig feature flag (runtime,
per-account, flip without redeploy — src/app/flags.ts, infra/README.md; default
ON). Reader cost circuit breaker: the `extract-mode` flag (enabled+mode=full →
GCV+Claude; mode=gcv → GCV only, every would-be Claude call lands on manual
entry; disabled → no reading at all — client skips upload+extract and shows a
sorry note over manual entry; submission keeps working). One flag, not two,
because Claude-without-GCV is invalid (tier 2 needs GCV's line crop). Env
fallback EXTRACT_MODE=full|gcv|off; flag flips replace the WHOLE hosted
document — include every flag (see infra/README.md). Store-images OFF no
longer changes the transport (always inline) — the server just never writes
photo/crop bytes to S3 (`keep:false`); only the telemetry JSON is kept, so
accuracy/speed reporting is unaffected. `sessions-report.ts
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
619467956318 was torn down 2026-07-05. Secrets (the GCV key) live in
each account's SSM under /aadl-sg/ and are fetched at cold start
(src/app/secrets.ts; the Lambda env carries only the parameter names — never
put secret values back into lambda_env/TF state). Security pass (2026-07-07):
outbound aadl.org requests refuse any redirect off *.aadl.org/https (cookie
containment, src/app/aadl.ts assertAllowedUrl); GET / ships a hash-based CSP +
security headers and API responses are no-store (server.ts cspFor); unknown
500s return a generic message (user-facing aadl.org outcomes are AadlError →
502 — the failure is upstream, not ours); the labeler binds 127.0.0.1.
Custom domains (v0.4.0): prod https://aadlcode.ctb3.net, test
https://aadlcode-test.ctb3.net — CloudFront in front of the Function URL
(which stays public as a debugging bypass). Per-env hosted
zone in bootstrap, delegated from ctb3.net (ctb3-general account, manual
one-time NS record — redo it if the zone is ever recreated). CloudFront must
NOT forward the viewer Host header (Function URLs route by Host — the
AllViewerExceptHostHeader managed policy handles it); origin read timeout is
60s (max without a quota bump). No OAC: SigV4 origins force browsers to send
x-amz-content-sha256 on POSTs.
Gotchas burned in already: Lambda rejects BuildKit attestation manifests
(build with --provenance=false --sbom=false); the Function URL needs a
public lambda:InvokeFunction grant besides InvokeFunctionUrl (PIN still holds
either way) — the bare Invoke API is closed by conditions, and the condition
KEY differs per action: FunctionUrlAuthType=NONE on the InvokeFunctionUrl
grant, InvokedViaFunctionUrl=true (`invoked_via_function_url`) on the
InvokeFunction grant. FunctionUrlAuthType on InvokeFunction is an API error —
AddPermission 400s, which broke the 2026-07-07 test deploy (if the URL ever
403s again, drop the condition on public-invoke first); the Function URL + its two permissions must apply serially
(concurrent AddPermission → 409); GitHub jobs with `environment:` present
OIDC sub `repo:…:environment:<name>` not `ref:…` (CI-role trust accepts
both); Android Chrome throttles main-thread canvas work after returning
from the camera app (constant ~13.4s toBlob stall) — client encodes in a
Web Worker via OffscreenCanvas (main-thread fallback kept).

## Caching rules (read before re-running anything)

- `data/cache` keys include reader model, reader-prompt hash, and GCV input
  resolution + JPEG quality (`src/harness/cachekey.ts`; GCV_MAX_EDGE/GCV_QUALITY env) —
  editing `prompt.ts` or models auto-invalidates.
- Only successful results are cached; errors retry on re-run. Cache replays
  report the ORIGINAL call's latencyMs (`cached` column marks them; report.md
  "fresh" percentiles are the honest timing).
- NOT keyed by image content: if files in `data/images` change under the same
  filename, wipe `data/prepped` and `data/cache` by hand.
- Photos and labels are private → gitignored (`data/images`, `data/labels.csv`,
  `data/manual cropped`). `out/` is also untracked; findings live in commit
  messages and `out/runs/postproc-analysis.md`.

## Findings so far (don't re-derive)

39 raw-framing photos, `none` arm. Best pipeline: **GCV 2400px + phrase
subtraction + tallest-line + minConf≥0.5 gate → Claude on GCV-line crop →
manual prefilled** = 97.4% end-to-end, <$0.003/img avg, 87% instant (0.4s).

- GCV reads fine, isolates badly: post-processing (`src/core/postproc.ts`) took it
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
  The sibling failure (headline fragments like "WE" / "WEPLAYGAMETHE"
  surviving subtraction and outranking the code at 0.89-0.94 conf, prod ×2)
  is FIXED: any line whose tokens are all headline vocab is printed
  (HEADLINE_WORDS in postproc.ts). Scene text itself is still open.
- Prompt-hardening that worked (in-sample): doodles-aren't-letters, ignore
  ghost strokes of cleaned-off codes, resolve ambiguous glyphs by the writer's
  own letterforms. Caveat everywhere: n=39, thresholds tuned while looking.

Speed push (2026-07-06, n=63 incl. harder field photos — gate t=0.5 now
89% cov · 89-91% precision; tier-2-on-crop 95.2%):

- GCV input: resolution matters (bbox/line choice degrades below 2400 —
  tier-2-from-original drops 95.2→90.5% with 1600px bboxes), JPEG quality
  does NOT (q60-70 ≈ q90 accuracy at half the bytes). Ship 2400px q0.7.
- Tier-2 must crop from a high-res source: 95.2% from the original photo
  (all 3 misses = wrong-line localization, zero transcription errors) vs
  92.1% from a q70 2400px upload. Hence client-side cropping.
- Haiku 4.5 on crops: 66.7%, glyph confusions everywhere, and barely faster
  than Sonnet 4.6 (fresh p50 1604 vs 2167ms). Not a lever. Sonnet 5 was not
  enabled in either account when tested (Bedrock Marketplace).
- Dropping per_char_confidence from the reader JSON contract: identical
  accuracy, fresh p50 2167→1657ms (−24%) — output tokens were the latency.
- Speculative tier-2 (pre-warm on marginal conf) judged not worth it: user
  rejects of a gate-passed tier-1 are rare in the field (≈1 in 90 sessions).
- Harness latency numbers: cache replays report the ORIGINAL call's latency —
  only `cached=false` rows (report.md "fresh" columns) measure this run.
- Post-ship ledger (v0.4.0-test.11.1, 22 sessions, deliberately hard photos,
  desktop→WiFi): shutter→verdict avg 1.5s·p99 3.8s (prod v0.4.0 was med
  5.5s); extract avg 873ms (server 549ms, GCV 436ms); tier1-gated precision
  95%, tier2 6/6, every wrong prefill oracle-caught. GCV service spikes
  (6-30s, two clusters, cleared on their own — external) → the hedge above.
  Lambda memory bump judged NOT worth it: only ~96ms/extract is CPU+S3.

Prod field batch (v0.5.1, 2026-07-07, 30 sessions — 13 = the 07-06 GCV
episode, 17 fresh):

- Latency healthy: fresh-batch GCV 310-535ms, hedge never fired, server total
  ~0.5s. Client extract "spikes" (3.6-11.6s) were pure cellular uplink of the
  ~870KB inline POST — external, like the GCV episode. No server lever.
- Gate-passed tier-1 rejects are NOT rare in the field: 6/26 (vs the ≈1-in-90
  estimate from friendly photos). All caught by approve-or-oracle; the two
  UNRECOVERED losses were both wrong-line localization (headline picked over
  the code) where the user then approved tier-2's read of the wrong crop and
  the oracle rejected it (truth-by-approval means those sessions score as
  phantom tier-2 ✓ in sessions-report — read `not_recognized` endings as
  suspect labels). Both real codes (QUADCATS, JEWEL) were in GCV's raw words
  all along → HEADLINE_WORDS fix above; replayed + re-baked, QUADCATS now
  tier1-instant at 0.86 and JEWEL's line crops correctly (tier2 reads it).
- Tier-2 transcription when the crop was right: 5/7. Misses: dropped-H
  (OVERTHEEDGE — correct code WAS in `alternatives`; the manual-screen chips
  earn their keep) and repeated-O undercount (GOOOAL vs GOOOOAL, one O drawn
  as a soccer ball). Prompt now routes drawing-as-character and count-doubt
  readings into `alternatives` (offline 61/67, no regressions on shared
  images); GOOOOAL itself STILL misses — Claude undercounts the O-run even
  when it explicitly sees the ball. Known-open; don't prompt-tune it further
  on n=1 (second attempt invented letters).

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
