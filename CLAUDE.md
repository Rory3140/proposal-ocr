# Proposal OCR API — CLAUDE.md

> **Always update this file and README.md whenever code changes are made.**

## Project Overview

Node.js Express API hosted on Google Cloud Run for PlugPV IT. Processes Amply proposal PDFs and Manual J reports using Google Cloud Vision OCR. Extracts structured HVAC data and uploads cropped room images to Bubble.

**Deployed at:** `https://proposal-ocr-api-46710174656.us-east1.run.app`
**GCP Project:** `white-faculty-438720-a3`
**Region:** `us-east1`

---

## Endpoints

### `GET /` — Health check

### `POST /ocr/design`
Main proposal OCR endpoint. Takes a PDF URL, runs Google Vision OCR, converts pages to images, uploads cropped images to Bubble, returns structured JSON.

**Request:**
```json
{ "pdf_url": "...", "api_key": "...", "bubble_env": "test" }
```
- `bubble_env`: `"test"` or `"live"` — controls Bubble upload target

**Response:** Title/address/date at top level, then `pages` array (pages 2+):
```json
{
  "title": "Office Test",
  "address": "630 7th Ave, Troy, NY 12182, USA",
  "created_on": "Feb 9, 2026",
  "total_pages": 11,
  "pages": [
    {
      "page": 2,
      "data": {
        "capacity": 15000,
        "unit_type": "Wall",
        "brand": "Generic",
        "room": "Bed 1",
        "heat": 12011,
        "cool": 4874,
        "latent_cooling": 340,
        "sensible_cooling": 4535,
        "sensible_ratio_(shr)": 0.93,
        "cfm_heating": 367,
        "cfm_cooling": 208,
        "height": 9.1,
        "floor_area": 206,
        "volume": 1872,
        "#_of_windows": 3,
        "#_of_exterior_walls": 2
      },
      "image_url": "https://c6bd947...cdn.bubble.io/f12345/proposal_page_2.png"
    }
  ]
}
```

**Numeric fields** (all returned as JS numbers, not strings):
`capacity`, `heat`, `cool`, `latent_cooling`, `sensible_cooling`, `sensible_ratio_(shr)`, `cfm_heating`, `cfm_cooling`, `height`, `floor_area`, `volume`, `#_of_windows`, `#_of_exterior_walls`

### `POST /ocr/manualj`
Extracts whole-house heat and cool from page 1 of a Manual J report. No Bubble upload — just returns numbers.

**Request:**
```json
{ "pdf_url": "...", "api_key": "..." }
```

**Response:**
```json
{ "heat": 24276, "cool": 11849 }
```

Parsed via regex on raw page 1 text (`Heat: 24,276 Btuh` / `Cool: 11,849 Btuh`).

### `POST /ocr/debug`
Returns raw block positions and word-level data for any page. Used when building parsing logic for new PDF formats.

**Request:**
```json
{ "pdf_url": "...", "api_key": "...", "page_number": 1 }
```
- `page_number`: optional — omit for pages 1–5
- Returns `raw_text` (full page), `all_blocks` (every block with x/y positions + `is_right_column` flag)

---

## Tech Stack

- Node.js + Express
- Google Cloud Vision API (`files:annotate`, `DOCUMENT_TEXT_DETECTION`)
- `sharp` — PNG cropping
- `pdf-img-convert` — PDF → PNG (uses pdfjs, returns Uint8Array)
- `axios` — Bubble file uploads
- Docker on Google Cloud Run

---

## Proposal PDF Layout (Amply format)

- **Page 1**: Title page — project name, address, creation date (centered, no image)
- **Pages 2+**: Split layout — left ~72.6% is room photo, right ~27.4% is data panel

### OCR parsing (`/ocr/design`):
1. `files:annotate` with `DOCUMENT_TEXT_DETECTION`
2. Filter blocks where `normalizedVertices[0].x >= 0.70` (right column)
3. Group into rows by Y midpoint proximity (tolerance: 0.012)
4. Sort rows left-to-right, join text
5. Parse key-value pairs via regex
6. Special cases:
   - Heat/Cool on same line: `Heat : 12,011 Btuh Cool : 4,874 Btuh`
   - Combined stats block: `Height Floor Area Volume # of Windows # of Exterior Walls` with separate value blocks
   - Merged digits (windows/walls): OCR may read stacked "3"/"2" as "32" — split when block height > 0.025
7. `normalizeData()` strips units and parses all numeric fields to JS numbers

### Image extraction:
- Pages 2+ converted to PNG via `pdf-img-convert`
- Cropped to left 71.3% of width (the photo side) using `sharp`
- Uploaded to `https://amplify.plugpv.com/{version}/fileupload`
- Bubble CDN URLs start with `//` — always prepend `https:`

---

## Manual J PDF Format

- **Page 1**: Summary page with whole-house loads
- Values appear in raw text as: `Heat: 24,276 Btuh` and `Cool: 11,849 Btuh`
- Regex parse is sufficient — no block-position logic needed
- Does not upload anything to Bubble

---

## Batching

Vision API max 5 pages per request:
1. Fetch pages 1–5 first → get `totalPages`
2. Fire remaining batches in parallel via `Promise.all`
Image extraction handles all pages the same way.

---

## Bubble Integration

- App domain: `amplify.plugpv.com`
- File upload: `https://amplify.plugpv.com/version-test/fileupload` or `/version-live/fileupload`
- `bubble_env: "test"` → version-test, `"live"` → version-live

---

## Deployment

```bash
"C:\Users\RoryWood\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd" run deploy proposal-ocr-api \
  --source . --region us-east1 --allow-unauthenticated --memory 1Gi --cpu 2 --timeout 300s
```

Dockerfile: `node:20-slim`

---

## Important Notes

- `api_key` always required in request body — no env var fallback
- Never add `Co-Authored-By` to git commits
- Always update CLAUDE.md and README.md when making code changes
- Vision API costs ~$1.50/1,000 pages after first 1,000 free/month
- Cloud Run free tier: 2M requests/month, 50 hours CPU
