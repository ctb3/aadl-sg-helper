# Bake-off harness (historical)

Offline measurement harness that proved the extraction pipeline now running
in `src/app`. Kept runnable for future re-baselines; not part of the deployed
app. Full narrative findings log: [`../../CLAUDE.md`](../../CLAUDE.md).

## Result

**97.4% end-to-end** (n=39, `none` arm): GCV 2400px + phrase subtraction +
tallest-line + minConf≥0.5 gate → Claude on the GCV-line crop → manual
prefilled. ~87% of photos resolve instantly on tier 1, <$0.003/img average.

Speed-push follow-up (n=63, harder field photos): tier-2-on-crop 95.2%,
provided the crop is cut from the **original** high-res photo, not a
downscaled upload (92.1% otherwise) — this is why the deployed app crops
client-side.

## Readers compared

| Reader | Engine | Status |
|---|---|---|
| `gcv` | Google Cloud Vision (DOCUMENT_TEXT) | **Won tier 1** (with post-processing) |
| `claude` | Bedrock Claude (Converse, multimodal) | **Won tier 2** (on crops; full-photo fails on small signs) |
| `nova` | Bedrock Nova (Converse, multimodal) | Dropped (~65%, prompt-insensitive) |
| `textract` | AWS Textract | Dropped (strictly worse than GCV; HANDWRITING tag useless here) |

Preprocessing arms: `none` (downscaled full photo) and `model_crop` (paid
Nova localizer bbox → crop). `model_crop` is obsolete — GCV's tier-1 line
bbox localizes for free and better — but stays runnable.

Metrics: exact full-code match (normalized: uppercase, spaces stripped —
submission is case/space-insensitive), character error rate, confidence
calibration (does low confidence predict errors?).

## Key findings (don't re-derive)

- GCV reads fine but isolates badly on its own: post-processing
  (`src/core/postproc.ts`) took it 0%→87%. Height signal alone ~54%, phrase
  signal alone ~5% — both are required.
- Line heights must come from glyph/symbol boxes; axis-aligned boxes around
  tilted words or curved ring text are inflated (why Textract LINE blocks fail).
- Claude full-photo fails when the sign is small in frame (downscale shrinks
  glyphs too far); a GCV-line crop fixes every such miss.
- GCV input resolution matters (bbox/line choice degrades below 2400px);
  JPEG quality doesn't (q60-70 ≈ q90 accuracy at half the bytes). Ship 2400px q0.7.
- Haiku 4.5 on crops: 66.7%, not meaningfully faster than Sonnet — not a lever.
- Dropping `per_char_confidence` from the reader JSON contract: same
  accuracy, ~24% faster (output tokens were the latency cost).
- Known open failure: scene text can outrank the real line (GCV once picked
  a house number at 0.99 conf) — confidence does not gate localization
  errors. Headline-fragment false positives are fixed (`HEADLINE_WORDS` in
  `postproc.ts`); generic scene text is still open.

## Commands

| Command | What it does |
|---|---|
| `npm run smoke` | Bake-off matrix, 1 image (catches creds/model-access gaps) |
| `npm run bake` | Full bake-off over every labeled image |
| `npm run label` | Labeler at :5178 — label new images, verify existing |
| `npm run preflight` | One tiny call per engine to verify cloud access |
| `npx tsx src/harness/analyze.ts` | Post-proc strategies + cascade sim, fully offline from `data/cache` (zero API calls) |
| `npx tsx src/harness/tier2.ts` | Claude on high-res crops at GCV line bboxes |
| `npx tsx src/harness/gcvprobe.ts` | Standalone GCV latency probe (gRPC vs REST, paid, no hedge) |

Bake-off filters: `npm run bake -- --reader claude|nova|textract|gcv --arm
none|model_crop --image sign01.jpg --limit 5 --force`.

Outputs land in `out/runs/<timestamp>/`: raw per-prediction JSON,
`results.csv`, `report.md` (exact-match table, CER, confidence calibration,
latency & cost). Paid calls are cached in `data/cache/`, keyed by reader
model + prompt hash + GCV input resolution/quality (see `CLAUDE.md` caching
rules) — `--force` bypasses.

## Prerequisites

Same as the app (Node 22, AWS creds, GCP Vision service account — see the
root [README](../../README.md#prerequisites)), plus images in
`data/images/` (or `IMAGES_DIR`) and hand labels in `data/labels.csv`
(private, gitignored; produced by `npm run label`).
