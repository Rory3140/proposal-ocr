# Proposal OCR API

Extracts structured HVAC data and room images from Amply proposal PDFs and Manual J reports using Google Cloud Vision OCR.

**Deployed at:** `https://proposal-ocr-api-46710174656.us-east1.run.app`

---

## Endpoints

### `GET /`
Health check. Returns `{"status":"ok","service":"proposal-ocr-api"}`.

---

### `POST /ocr/design`
Main endpoint — processes an Amply proposal PDF. Returns structured HVAC data per room plus cropped room images uploaded to Bubble.

**Request body:**
```json
{
  "pdf_url": "https://your-bubble-cdn.com/path/to/file.pdf",
  "api_key": "your-google-vision-api-key",
  "bubble_env": "test"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `pdf_url` | Yes | URL to the proposal PDF (supports `//` prefix) |
| `api_key` | Yes | Google Cloud Vision API key |
| `bubble_env` | No | `"test"` or `"live"` — controls Bubble upload target. Defaults to `"live"` |

**Response:**
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

All numeric fields are returned as numbers (not strings). `image_url` is `null` if upload fails for a page.

---

### `POST /ocr/manualj`
Extracts whole-house heat and cool totals from page 1 of a Manual J report. No image upload.

**Request body:**
```json
{
  "pdf_url": "https://your-bubble-cdn.com/path/to/file.pdf",
  "api_key": "your-google-vision-api-key"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `pdf_url` | Yes | URL to the Manual J PDF |
| `api_key` | Yes | Google Cloud Vision API key |

**Response:**
```json
{
  "heat": 24276,
  "cool": 11849
}
```

---

### `POST /ocr/debug`
Returns raw block positions and word-level data for any page. Used when building parsing logic for new PDF formats.

**Request body:**
```json
{
  "pdf_url": "https://your-bubble-cdn.com/path/to/file.pdf",
  "api_key": "your-google-vision-api-key",
  "page_number": 1
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `pdf_url` | Yes | URL to the PDF |
| `api_key` | Yes | Google Cloud Vision API key |
| `page_number` | No | Specific page to debug. Omit to get pages 1–5 |

Returns `raw_text` (full page text), `all_blocks` (every block with x/y positions and `is_right_column` flag), and `right_column` (filtered right-column blocks sorted by Y).

---

## Deploy to Google Cloud Run

```bash
gcloud run deploy proposal-ocr-api \
  --source . \
  --region us-east1 \
  --allow-unauthenticated \
  --memory 1Gi \
  --cpu 2 \
  --timeout 300s
```

### Prerequisites
- Google Cloud SDK (`gcloud`) installed and authenticated
- GCP project with billing enabled (`white-faculty-438720-a3`)
- Cloud Vision API and Cloud Build API enabled

---

## Using from Bubble

In your Bubble app, use the API Connector plugin:

**For proposal PDFs:**
1. Method: `POST`
2. URL: `https://proposal-ocr-api-46710174656.us-east1.run.app/ocr/design`
3. Headers: `Content-Type: application/json`
4. Body:
```json
{
  "pdf_url": "<pdf_file>",
  "api_key": "<your-vision-key>",
  "bubble_env": "live"
}
```

**For Manual J reports:**
1. Method: `POST`
2. URL: `https://proposal-ocr-api-46710174656.us-east1.run.app/ocr/manualj`
3. Body:
```json
{
  "pdf_url": "<pdf_file>",
  "api_key": "<your-vision-key>"
}
```

Use `"bubble_env": "test"` when working in the Bubble test environment.

---

## Notes

- `api_key` is always required in the request body — no env var fallback
- Vision API batches 5 pages per request; all batches run in parallel
- Image conversion and OCR run in parallel to minimize latency
- Vision API costs ~$1.50/1,000 pages after the first 1,000 free/month
- Cloud Run free tier: 2M requests/month, 50 hours CPU
