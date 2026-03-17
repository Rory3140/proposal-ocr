# Proposal OCR API

Extracts structured HVAC data and room images from Amply proposal PDFs using Google Cloud Vision OCR.

**Deployed at:** `https://proposal-ocr-api-46710174656.us-east1.run.app`

---

## Endpoints

### `GET /`
Health check. Returns `{"status":"ok","service":"proposal-ocr-api"}`.

---

### `POST /ocr`
Main endpoint — returns structured JSON from a proposal PDF, including per-page HVAC data and cropped room images uploaded to Bubble.

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
| `pdf_url` | Yes | URL to the proposal PDF (supports `//` prefix, will be normalized to `https://`) |
| `api_key` | Yes | Google Cloud Vision API key |
| `bubble_env` | No | `"test"` or `"live"` — controls which Bubble environment images are uploaded to. Defaults to `"live"` |

- `"test"` → uploads to `https://amplify.plugpv.com/version-test/fileupload`
- `"live"` → uploads to `https://amplify.plugpv.com/version-live/fileupload`

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
        "capacity": "15K BTUh",
        "unit_type": "Wall",
        "brand": "Generic",
        "room": "Bed 1",
        "height": "9.1 ft",
        "floor_area": "206 sq ft",
        "volume": "1,872 cu ft",
        "#_of_windows": "3",
        "#_of_exterior_walls": "2",
        "heat": "12,011 Btuh",
        "cool": "4,874 Btuh",
        "latent_cooling": "340",
        "sensible_cooling": "4,535",
        "sensible_ratio_(shr)": "0.93",
        "cfm_heating": "367",
        "cfm_cooling": "208"
      },
      "image_url": "https://c6bd947...cdn.bubble.io/f12345/proposal_page_2.png"
    }
  ]
}
```

`image_url` is the cropped room photo (left ~71.3% of the page) uploaded to Bubble. It will be `null` if the image upload fails for a page (OCR data is still returned).

---

### `POST /ocr/debug`
Debug endpoint — returns raw block positions and word-level data for template debugging.

**Request body:**
```json
{
  "pdf_url": "https://your-bubble-cdn.com/path/to/file.pdf",
  "api_key": "your-google-vision-api-key",
  "page_number": 2
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `pdf_url` | Yes | URL to the proposal PDF |
| `api_key` | Yes | Google Cloud Vision API key |
| `page_number` | No | Specific page to debug. Omit to get pages 1–5 |

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

1. Method: `POST`
2. URL: `https://proposal-ocr-api-46710174656.us-east1.run.app/ocr`
3. Headers: `Content-Type: application/json`
4. Body:
```json
{
  "pdf_url": "<pdf_file>",
  "api_key": "<your-vision-key>",
  "bubble_env": "live"
}
```

Use `"bubble_env": "test"` when working in the Bubble test environment, `"live"` for production.

---

## Notes

- `api_key` is always required in the request body — there is no env var fallback
- Vision API batches 5 pages per request; all batches run in parallel
- Image conversion and OCR run in parallel to minimize latency
- Vision API costs ~$1.50/1,000 pages after the first 1,000 free/month
- Cloud Run free tier: 2M requests/month, 50 hours CPU
