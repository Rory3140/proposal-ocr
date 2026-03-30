# Proposal OCR API — CLAUDE.md

> **Always update this file and README.md whenever code changes are made.**

## Project Overview

Node.js Express API hosted on Google Cloud Run for PlugPV IT. Processes Amply proposal PDFs and Manual J reports using Google Cloud Vision OCR. Extracts structured HVAC data and uploads cropped room images to Google Drive.

**Deployed at:** `https://proposal-ocr-api-46710174656.us-east1.run.app`
**GCP Project:** `white-faculty-438720-a3`
**Region:** `us-east1`

---

## Endpoints

### `GET /` — Health check

### `POST /ocr/design`
Main proposal OCR endpoint. Takes a PDF URL, runs Google Vision OCR, converts pages to images, uploads cropped images to Google Drive, returns structured JSON.

**Request:**
```json
{ "pdf_url": "...", "api_key": "...", "google_drive_folder_id": "1ABC..." }
```
- `google_drive_folder_id`: optional — Drive folder ID to upload images into. The folder must be shared with the service account email. If omitted, files are uploaded to the service account's root Drive.

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
      "image_url": "https://drive.google.com/file/d/FILE_ID/view"
    }
  ]
}
```

**Numeric fields** (all returned as JS numbers, not strings):
`capacity`, `heat`, `cool`, `latent_cooling`, `sensible_cooling`, `sensible_ratio_(shr)`, `cfm_heating`, `cfm_cooling`, `height`, `floor_area`, `volume`, `#_of_windows`, `#_of_exterior_walls`

### `POST /ocr/manualj`
Extracts whole-house heat and cool from page 1 of a Manual J report. No Drive upload — just returns numbers.

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
- `googleapis` — Google Drive file uploads
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
- Uploaded to Google Drive via `googleapis` using service account auth
- Files are made publicly readable (`anyone` reader permission)
- Returned URLs: `https://drive.google.com/uc?export=view&id={fileId}` (direct image URL, works in Bubble dynamic image fields)

---

## Manual J PDF Format

- **Page 1**: Summary page with whole-house loads
- Values appear in raw text as: `Heat: 24,276 Btuh` and `Cool: 11,849 Btuh`
- Regex parse is sufficient — no block-position logic needed
- Does not upload anything to Drive

---

## Batching

Vision API max 5 pages per request:
1. Fetch pages 1–5 first → get `totalPages`
2. Fire remaining batches in parallel via `Promise.all`
Image extraction handles all pages the same way.

---

## Google Drive Integration

- Auth: service account JSON **base64-encoded** and stored in `GOOGLE_SERVICE_ACCOUNT_JSON` env var on Cloud Run
  - The app does `JSON.parse(Buffer.from(b64, "base64").toString("utf8"))` to decode it
  - Must be base64 — passing raw JSON via `--set-env-vars` always corrupts it (colons/commas break gcloud's dict arg parser)
- Service account: `svc-amplify-gdrive@white-faculty-438720-a3.iam.gserviceaccount.com`
- Service account key file stored locally as `service-account.json` (gitignored)
- Scope: `https://www.googleapis.com/auth/drive` (full drive scope required — `drive.file` won't see shared folders)
- The target folder must be shared with the service account email (Content Manager or higher)
- **Shared Drive folders require `supportsAllDrives: true`** on both `files.create` and `permissions.create` calls — without it the API returns "File not found" even if the folder exists and is shared
- Each uploaded file is granted `anyone` reader permission so URLs are publicly accessible
- Drive API must be enabled on GCP project `white-faculty-438720-a3`

---

## Deployment

**Always use PowerShell for gcloud commands — running gcloud via bash fails (Python not found).**

### Deploy to Cloud Run
```powershell
& 'C:\Users\RoryWood\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd' run deploy proposal-ocr-api `
  --source 'C:\Users\RoryWood\Documents\Proposal OCR' `
  --region us-east1 --allow-unauthenticated --memory 1Gi --cpu 2 --timeout 300s
```

### Set GOOGLE_SERVICE_ACCOUNT_JSON env var
Must be base64-encoded. Run this via PowerShell:
```powershell
$bytes = [System.IO.File]::ReadAllBytes('C:\Users\RoryWood\Documents\Proposal OCR\service-account.json')
$b64 = [Convert]::ToBase64String($bytes)
& 'C:\Users\RoryWood\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd' run services update proposal-ocr-api --region us-east1 --set-env-vars "GOOGLE_SERVICE_ACCOUNT_JSON=$b64"
```
From Claude Code, wrap in `powershell.exe -Command "..."` with `\$` to escape dollar signs.

Dockerfile: `node:20-slim`

---

## Local Development

**Do NOT run `npm install` normally** — the `canvas` dependency (used by `pdf-img-convert`) fails to build native binaries on Node v24. Always use:
```bash
npm install --ignore-scripts
```
Then install `@napi-rs/canvas` as a canvas shim:
```bash
npm install @napi-rs/canvas
```

**To start the server locally:**
```bash
GOOGLE_SERVICE_ACCOUNT_JSON=$(cat service-account.json | base64) node index.js
```
Note: on Windows use PowerShell to base64-encode:
```powershell
$b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes('service-account.json'))
$env:GOOGLE_SERVICE_ACCOUNT_JSON = $b64
node index.js
```

**To test locally** (the server fetches PDFs by URL — no local file server needed):
```bash
curl -X POST http://localhost:8080/ocr/design \
  -H "Content-Type: application/json" \
  -d '{"pdf_url":"YOUR_PDF_URL","api_key":"YOUR_VISION_API_KEY","google_drive_folder_id":"FOLDER_ID"}'
```

**To test production:**
```bash
curl -X POST https://proposal-ocr-api-46710174656.us-east1.run.app/ocr/design \
  -H "Content-Type: application/json" \
  -d '{"pdf_url":"YOUR_PDF_URL","api_key":"YOUR_VISION_API_KEY","google_drive_folder_id":"1NlGlRvKY5buuM9iM_HLKUXPD73DPXfrl"}'
```

---

## Important Notes

- `api_key` always required in request body — no env var fallback
- Never add `Co-Authored-By` to git commits
- Always update CLAUDE.md and README.md when making code changes
- Vision API costs ~$1.50/1,000 pages after first 1,000 free/month
- Cloud Run free tier: 2M requests/month, 50 hours CPU
