# Proposal OCR API

Extracts structured data from Amply proposal PDFs using Google Cloud Vision OCR.

## Endpoints

### `POST /ocr`
Main endpoint — returns structured JSON from a proposal PDF.

**Request body:**
```json
{
  "pdf_url": "https://your-bubble-cdn.com/path/to/file.pdf",
  "api_key": "your-google-vision-api-key"  // optional if set as env var
}
```

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
      }
    }
  ]
}
```

### `POST /ocr/debug`
Debug endpoint — returns raw block positions and word-level data for template debugging.

**Request body:**
```json
{
  "pdf_url": "https://your-bubble-cdn.com/path/to/file.pdf",
  "api_key": "your-google-vision-api-key",
  "page_number": 2  // optional — specific page to debug
}
```

### `GET /`
Health check.

---

## Deploy to Google Cloud Run

### Prerequisites
- Google Cloud SDK (`gcloud`) installed
- A GCP project with billing enabled
- Cloud Vision API enabled (same project or use API key from another project)

### Steps

```bash
# 1. Set your project
gcloud config set project YOUR_PROJECT_ID

# 2. Enable required APIs
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com

# 3. Deploy (builds and deploys in one command)
gcloud run deploy proposal-ocr-api \
  --source . \
  --region us-east1 \
  --allow-unauthenticated \
  --set-env-vars GOOGLE_VISION_API_KEY=your-api-key-here \
  --memory 512Mi \
  --timeout 120s

# 4. Note the URL it gives you, e.g.:
# https://proposal-ocr-api-xxxxx-ue.a.run.app
```

### Using from Bubble

In your Bubble app, use the API Connector plugin:
1. Add a new API: `Proposal OCR`
2. Method: `POST`
3. URL: `https://your-cloud-run-url.a.run.app/ocr`
4. Headers: `Content-Type: application/json`
5. Body:
```json
{
  "pdf_url": "<pdf_file>"
}
```
6. If you set the API key as an env var on Cloud Run, you don't need to send it in the body.
   Otherwise add `"api_key": "your-key"` to the body.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GOOGLE_VISION_API_KEY` | Your Google Cloud Vision API key (optional if passed in request body) |
| `PORT` | Server port (default: 8080, Cloud Run sets this automatically) |

### Memory & Timeout

- Set `--memory 512Mi` (or `1Gi` for very large PDFs)
- Set `--timeout 120s` to handle large multi-page PDFs
- Cloud Run free tier: 2 million requests/month
