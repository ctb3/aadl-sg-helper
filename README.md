# aadl-sg-helper

AADL Summer Game helper — **handwriting-extraction bake-off harness.**

This is a *measurement harness*, not the app. AADL Summer Game yard signs (a
circular sign with a white horizontal band lower-center) carry a **handwritten**
code. This harness measures whether three OCR/vision engines can reliably read
that code from a phone photo, so we can decide if an app is worth building.

> Governing constraint: codes are **user-generated** (charset `[A-Z0-9]`, ≤12
> chars, no dictionary). Faithful glyph reading is the goal — the LLM prompt
> forbids "correcting" messy handwriting toward real words. There is **no
> validation oracle**; ground truth comes only from hand-labeling.

## What it compares

**Readers (4 arms across 3 engine categories):**

| Reader     | Engine                                   | Code isolation strategy |
|------------|------------------------------------------|-------------------------|
| `claude`   | Bedrock — Claude (Converse, multimodal)  | prompt instruction |
| `nova`     | Bedrock — Nova (Converse, multimodal)    | prompt instruction |
| `textract` | AWS Textract                             | HANDWRITING block filter |
| `gcv`      | Google Cloud Vision (DOCUMENT_TEXT)      | spatial band heuristic |

**Preprocessing arms (2):**

- `none` — whole image downscaled to ~1500px longest edge.
- `model_crop` — a cheap localizer model returns the handwritten-code bounding
  box; the high-res crop is fed to all four readers.

→ 4 readers × 2 arms = **8 predictions per image** (+1 localizer call/image).

## Prerequisites

1. **Node 20+.**
2. **AWS**: credentials via the standard chain, region set. **Bedrock model
   access enabled** for your chosen Claude, Nova, and localizer models; Textract
   enabled. (Claude & Nova both run through the Bedrock **Converse** API.)
3. **GCP**: a service-account JSON with the **Vision API** enabled;
   `GOOGLE_APPLICATION_CREDENTIALS` pointed at it.
4. Images in `data/images/` (or point `IMAGES_DIR` elsewhere).

Model IDs, region, thresholds, and cost constants are all set in `.env` — see
`.env.example`. Bedrock IDs default to cross-region inference profiles
(`us.` prefix); adjust to match your access.

## Usage

```bash
npm install
cp .env.example .env      # then fill in creds / model IDs

# 0. Verify cloud access (one tiny call per engine, sub-cent total)
npm run preflight

# 1. Label your images (opens a local labeler in the browser)
npm run label             # → writes data/labels.csv (filename,code)

# 2. Smoke test — 1 image, all readers × arms (catches creds/model-access gaps)
npm run smoke

# 3. Full bake-off over every labeled image
npm run bake

# Optional filters:
npm run bake -- --reader gcv --arm none --image sign01.jpg --limit 5 --force
```

Outputs land in `out/`:

- `out/runs/<timestamp>/*.json` — raw per-prediction records (engine output +
  parsed code + confidence + latency + cost).
- `out/runs/<timestamp>/results.csv` — flat rows for your own analysis.
- `out/runs/<timestamp>/report.md` — the deliverable: exact-match table
  (reader × arm), CER, confidence-calibration buckets, latency & cost.

Paid API calls are cached in `data/cache/` keyed by (image, reader, arm), so
re-runs and report tweaks don't re-bill. Use `--force` to bypass the cache.

## Metrics

- **Headline:** exact full-code match rate (normalized = uppercase, spaces
  stripped — submission is case- and space-insensitive). A code counts only if
  every character is right.
- **Secondary:** character error rate (Levenshtein / truth length).
- **Secondary:** confidence calibration — does low reported confidence actually
  predict errors? Directly targets the "silent confident wrong" risk.

Sanity-check the raw JSON against the images by eye, especially any
**high-confidence misses** (silent wrong) and GCV `none`-arm isolation failures.
