# Proposal OCR API

Extracts structured HVAC data and room images from Amply proposal PDFs and Manual J reports using Google Cloud Vision OCR.

**Deployed at:** `https://proposal-ocr-api-46710174656.us-east1.run.app`

---

## Endpoints

### `GET /`
Health check. Returns `{"status":"ok","service":"proposal-ocr-api"}`.

---

### `POST /ocr/design`
Main endpoint — processes an Amply proposal PDF. Returns structured HVAC data per room plus cropped room images uploaded to Google Drive.

**Request body:**
```json
{
  "pdf_url": "https://example.com/path/to/file.pdf",
  "api_key": "your-google-vision-api-key",
  "google_drive_folder_id": "1ABCdef..."
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `pdf_url` | Yes | URL to the proposal PDF (supports `//` prefix) |
| `api_key` | Yes | Google Cloud Vision API key |
| `google_drive_folder_id` | No | Google Drive folder ID to upload images into. Folder must be shared with the service account. If omitted, uploads to service account's root Drive. |

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
      "image_url": "https://drive.google.com/file/d/FILE_ID/view"
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

## Google Drive Auth Setup

Image uploads use a service account. Set up once:

1. In GCP console, create a service account and download its JSON key
2. Enable the **Google Drive API** on GCP project `white-faculty-438720-a3`
3. Add the key JSON as a Cloud Run secret named `GOOGLE_SERVICE_ACCOUNT_JSON`
4. Share your target Drive folder with the service account's email (find it in the JSON as `client_email`)

The service account only gets `drive.file` scope — it can only see files it uploads itself.

---

## Notes

- `api_key` is always required in the request body — no env var fallback
- Vision API batches 5 pages per request; all batches run in parallel
- Image conversion and OCR run in parallel to minimize latency
- Vision API costs ~$1.50/1,000 pages after the first 1,000 free/month
- Cloud Run free tier: 2M requests/month, 50 hours CPU
