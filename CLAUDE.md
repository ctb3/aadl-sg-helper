# AADL Summer Game — handwriting-extraction bake-off

Measurement harness (not the app) for extracting the handwritten code from
AADL Summer Game yard-sign photos. Eventual goal: stateless mobile web app on
AWS that hands the user their code for play.aadl.org.

## The one governing constraint

Codes are USER-GENERATED: `[A-Z0-9]`, ≤12 chars, arbitrary — no dictionary, no
word priors. Never let an LLM "correct" toward a real word; prompts must demand
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
- AWS: Windows `~/.aws`, profile `service-aadl-sg-helper`, region `us-east-2`
  (set in `.env`). Bedrock models need per-model Marketplace subscription;
  `claude-sonnet-5` is gated off for this account (Sonnet 4.6 in use).
- Temp scripts must live inside the project — cross-drive tsx imports fail.
