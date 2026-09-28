# Backend

Flask API and OCR pipeline for uBlockAI. See the [root README](../README.md) for
the full architecture and API reference; this file covers running the backend on
its own.

## What it does

- Serves `POST /api/analyze_claims`, which extracts text from a post's image
  (or a video post's poster frame) and hands it to a LangGraph ReAct agent
- Serves `POST /api/feedback` for the extension's false-positive reports
- Serves an unauthenticated `GET /api/health` probe
- Exposes the OCR pipeline as a CLI for tuning it without the agent

## Setup

1. Python 3.10+
2. Create the venv and install dependencies:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt   # requirements.txt to run only
```

3. Install Tesseract OCR (`pytesseract` shells out to the binary):
   - **macOS**: `brew install tesseract`
   - **Debian/Ubuntu**: `sudo apt-get install tesseract-ocr`
   - **Windows**: the UB Mannheim build, with `tesseract` on `PATH`

4. Create `app/.env`:

```
OPENAI_API_KEY=sk-...
ALLOWED_ORIGINS=chrome-extension://<your-extension-id>
```

`ALLOWED_ORIGINS` is required in practice: CORS fails closed, so an empty
allowlist blocks every browser origin.

## Run the API

```bash
.venv/bin/python -m flask --app app.main run --host 0.0.0.0 --port 8000 --debug
```

Production:

```bash
.venv/bin/gunicorn -c gunicorn.conf.py app.main:app
```

Analysis requires an API key. Mint one with:

```bash
.venv/bin/python -m app.scripts.manage_api_keys mint --label laptop
```

## Run the OCR CLI

```bash
.venv/bin/python app/post_classifier.py --url "https://example.com/post" --caption "caption text here"
```

Useful flags: `--poster-url` analyses a video's poster frame instead of
scraping the post, `--ocr-profile {fast,accurate}` picks the OCR variant grid,
`--no-include-caption` drops the caption from the combined payload, and
`--profile-ocr` reports per-variant timing and yield and exits.

Output is a JSON object with `llm-input-text` (caption, alt text and OCR text
combined), `caption`, and `alt-text`. A fourth key, `ocr-errors`, is added when
at least one image failed OCR, so callers must not assume a fixed key count. The
key is `llm-input-text` with hyphens - the earlier `llm_input_text` in this file
was never a real key. No image URLs are returned, despite what this file used to
say.
