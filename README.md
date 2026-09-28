# uBlockAI

An AI-powered Chrome extension that detects and blocks misinformation in social media feeds, specifically designed to protect senior citizens from AI-generated fake news.

## Overview

uBlockAI acts as an ad-blocker analog for AI misinformation. It analyses posts on Instagram and Threads, extracting text from post images with OCR and from video posters, then has an LLM agent verify the resulting claims against reliable news sources and flag likely false information before the user engages with it.

## Features

- **Multi-platform**: Per-platform DOM adapters drive scanning, so Instagram and Threads are both supported and adding a platform is a new adapter rather than a new code path
- **OCR Integration**: Extracts text from post images using Tesseract OCR, through a preprocessing grid that runs several variants and keeps the best-scoring text
- **Video and Reel support**: Reels are analysed through their poster frame. The video itself is not decoded - see [Known limitations](#known-limitations)
- **AI-Powered Verification**: A LangGraph ReAct agent verifies claims with web search, source-credibility scoring and numeric verification
- **Misinformation Detection**: Produces an AI-generated risk score, a misinformation risk score, a verdict, an explanation, and step-by-step reasoning with evidence
- **User Control**: Per-user risk thresholds, a choice of hiding action, a trust list for "show anyway" posts, and optional telemetry
- **Visual Flagging**: Blurs, replaces with a warning panel, or removes posts that trip a threshold
- **Accessibility**: Keyboard-operable, screen-reader-announced, and with a senior-friendly text size setting
- **Localization**: Strings resolve through `chrome.i18n`; English is the default locale and the fallback

## Architecture

### Frontend (Chrome Extension)
- **Location**: `frontend/extension/`
- **Manifest**: Manifest v3
- **Content script**: `src/script.js`, injected into the platforms listed in `manifest.json`. It orchestrates only; platform selectors live in `src/adapters/`, everything reusable in `src/lib/`
- **Service worker**: `background.js`, handles backend requests, the feedback queue and the trusted-key set
- **Extension pages**: `popup.html` (settings and statistics), `options.html` (backend URL, API key, text size)
- **Localization**: `_locales/`, with `_locales/en/messages.json` as the default locale

### Backend (Flask + LangGraph)
- **Location**: `backend/`
- **Framework**: Flask 3 with the `async` extra, async views, fail-closed CORS, per-token rate limiting and API-key auth
- **Entry point**: `app/main.py`; the API is the `api` blueprint mounted at `/api`
- **Agent**: A single LangGraph ReAct agent (`app/agents/langchain_agent.py`) compiled once per process. It is *not* a multi-agent system: one model with tools, not a graph of cooperating agents
- **Tools** (`app/tools/registry.py`):
  - `web_search_tool` - Brave Search, with a DuckDuckGo HTML fallback
  - `credibility_tool` - source reliability tiering
  - `numeric_verify` - sanity-checks the numbers in a claim
  - OCR is not a tool; it is `app/post_classifier.py`, run before the agent
- **Output contract**: The agent's response shape is generated from the Pydantic model in `app/schemas/agent_io.py` and injected into the prompt, so the documented contract and the enforced schema cannot drift

## Tech Stack

### Frontend
- JavaScript (ES modules), no build step or bundler
- Chrome Extension Manifest v3
- HTML/CSS for the popup and options pages
- ESLint and Prettier; unit tests on `node --test`

### Backend
- **Python 3.10+** (CI runs 3.12)
- **Flask 3** with `flask[async]`
- **LangChain / LangGraph** for the ReAct agent
- **Tesseract OCR** via `pytesseract`, with **Pillow** preprocessing
- **BeautifulSoup** for the post scrape path
- **OpenAI** - `gpt-4o` by default, override with `OPENAI_MODEL`
- **Gunicorn** (`gthread`) for production, configured by `gunicorn.conf.py`

## Installation

### Prerequisites
- Python 3.10 or higher
- Node.js 20 or higher
- Tesseract OCR on `PATH`
- Chrome

### Backend Setup

`make setup` does all of this: it creates `backend/.venv`, installs the backend
and dev dependencies, installs the extension's npm packages, and installs a git
pre-commit hook.

```bash
make setup
```

To do it by hand:

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements-dev.txt   # requirements.txt if you are not running the gates
```

Install Tesseract OCR (`pytesseract` shells out to the binary; without it every
analysis request fails at OCR time):

- **macOS**: `brew install tesseract`
- **Debian/Ubuntu**: `sudo apt-get install tesseract-ocr`
- **Windows**: install the UB Mannheim build and ensure `tesseract` is on `PATH`

`python3 scripts/dev_setup.py` from the repository root does the same setup and
prints what is still missing.

Create `backend/app/.env`:

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
BRAVE_API_KEY=...          # optional; enables Brave Search instead of the DDG fallback
ALLOWED_ORIGINS=chrome-extension://<your-extension-id>
```

`ALLOWED_ORIGINS` is not optional in practice. CORS fails closed: an empty
allowlist means no browser origin may call the API, and the extension will fail
with an opaque network error. Your unpacked extension id is shown on
`chrome://extensions` for the loaded extension; it differs from a store build's.

Start the server:

```bash
make dev
# or: cd backend && .venv/bin/python -m flask --app app.main run --host 0.0.0.0 --port 8000 --debug
```

For production, use the checked-in Gunicorn config. The defaults matter: the
views are `async def`, so the `gthread` worker class is what lets one process
serve several analyses at once, and the 30-second default timeout would kill
legitimate requests mid-analysis.

```bash
cd backend
.venv/bin/gunicorn -c gunicorn.conf.py app.main:app
```

`backend/gunicorn.conf.py` is picked up automatically from the working
directory. Note that the rate limiter and any in-process caches are per worker,
so the effective global rate limit is `workers x threads x ANALYZE_RATE_LIMIT`.

### Chrome Extension Setup

1. Open `chrome://extensions/` and enable **Developer mode**
2. Click **Load unpacked** and select the `frontend/extension` folder
3. Copy the extension id from the loaded extension's card
4. Add that id to `ALLOWED_ORIGINS` on the backend and restart it
5. Mint an API key and paste it into the extension's options page:

   ```bash
   cd backend
   .venv/bin/python -m app.scripts.manage_api_keys mint --label laptop
   ```

   The plaintext key is shown once. Only its SHA-256 is stored. The extension
   keeps the key in `chrome.storage.local`, never in `storage.sync`, so it is
   not uploaded to the user's Google account.
6. Navigate to Instagram or Threads; the extension begins scanning

The extension defaults to the hosted backend at
`https://hack-ncstate-2026.onrender.com`. Point it at your own deployment from
the options page, which also requests the host permission for that origin.

### Development Commands

| Command | Effect |
|---|---|
| `make setup` | venv, dependencies, npm packages, git hook |
| `make dev` | Backend on `:8000` with reload |
| `make test` | Backend pytest |
| `make lint` | Ruff + ESLint |
| `make format` | Ruff format check + Prettier check |
| `make type` | mypy |
| `make check` | All four gates, as CI runs them |
| `make audit` | `pip-audit` against `requirements.txt` |
| `make hooks` | Install the pre-commit hook |

Extension tests run on their own:

```bash
cd frontend/extension && npm test    # node --test src/lib/*.test.js
```

## Usage

### Testing the OCR path directly

`app/post_classifier.py` is a CLI over the OCR pipeline, useful for tuning it
without going through the agent:

```bash
cd backend
.venv/bin/python app/post_classifier.py \
  --url "https://www.instagram.com/p/EXAMPLE/" \
  --caption "Example caption"

# A video/Reel post: analyse the poster frame instead of scraping the page
.venv/bin/python app/post_classifier.py \
  --url "https://www.instagram.com/reel/EXAMPLE/" \
  --poster-url "https://scontent.cdninstagram.com/v/t51/poster.jpg"

# Measure the cost and yield of each OCR variant before changing the grid
.venv/bin/python app/post_classifier.py --url "<image-url>" --profile-ocr
```

Output is JSON with three keys: `llm-input-text` (caption + alt text + OCR
text, combined), `caption`, and `alt-text`.

### Using the Extension

1. Open Instagram or Threads and scroll; posts are analysed as they appear
2. Posts over a threshold are blurred, replaced with a warning panel, or removed
3. **Show post anyway** reveals a post and remembers the decision
4. **Report mistake** files a false-positive report
5. Click the toolbar icon for thresholds, the hiding action, statistics and text
   size; **Advanced settings** opens the options page for the backend and key

### API Endpoints

All routes are mounted under `/api`. Except for `/health`, every route requires
an API key, sent as `X-API-Key: <key>` or `Authorization: Bearer <key>`.

#### `GET /api/health`

Liveness and readiness. **Unauthenticated**, so an orchestrator does not need a
credential. Returns 200 when configured, 503 when not.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "model": "gpt-4o",
  "checks": {
    "api_key_configured": true,
    "search_provider_configured": false,
    "feedback_dir_writable": true
  }
}
```

#### `POST /api/analyze_claims`

Analyses one post. Rate limited per API key (`ANALYZE_RATE_LIMIT` per
`RATE_WINDOW_SECONDS`, default 20 per 60s).

Request body - every field but `url` is optional:

| Field | Type | Notes |
|---|---|---|
| `url` | string | Post URL, or a direct image URL. Required. Must be on the backend's host allowlist |
| `caption` | string | Post caption, max 5000 chars |
| `alt_text` | string | Image alt text, max 2000 chars |
| `metadata` | object | Passed through to the agent as context, e.g. `{"permalink": "/p/ABC/"}` |
| `request_id` | string | Trace id echoed into the logs |
| `max_images` | int | 1-10, images to OCR per post. Default 3 |
| `is_video` | bool | The post is a video/Reel. Default false |
| `video_thumb` | string | Poster frame URL. Only read when `is_video` is true |

There is no `ocr_text` request field. The backend runs OCR itself, from the
images it finds for the post.

```json
{
  "url": "https://scontent.cdninstagram.com/v/t51/example.jpg",
  "caption": "a claim to check",
  "alt_text": "",
  "is_video": true,
  "video_thumb": "https://scontent.cdninstagram.com/v/t51/poster.jpg"
}
```

Response body - the agent's `AgentOutput`, verbatim:

| Key | Type | Notes |
|---|---|---|
| `ai_generated_risk_score` | float | 0-1 |
| `misinformation_risk_score` | float | 0-1 |
| `verdict` | string | `likely_true`, `likely_false`, `mixed`, `unverifiable` |
| `confidence` | float | 0-1 |
| `explanation` | string | Human-readable, shown in the warning panel |
| `reasoning_chain` | string[] | Step-by-step reasoning |
| `evidence` | object[] | `claim_id`, `source_url`, `source_credibility`, `title`, `retrieved_at`, `summary`, `supporting` |
| `uncertainties` | string[] | What could not be verified |
| `tool_rounds` | int | Diagnostic only |

There is no `ai_score`, `misinformation_score` or `reasoning` key. Those were
the names this section used to document, and nothing has ever emitted them.

Errors are JSON, never HTML, and never carry internal detail: `400` for a
malformed or schema-violating body, `401` for a missing or invalid key, `429`
with `Retry-After` when throttled, `502` if the agent produced unusable output,
`500` otherwise.

#### `POST /api/feedback`

Accepts false-positive and false-negative reports from the extension, appended
to newline-delimited JSON under `app/feedback/`. Rate limited per key
(`FEEDBACK_RATE_LIMIT`, default 60 per 60s).

```json
{ "reports": [{ "type": "false_positive", "imageUrl": "https://...", "caption": "c", "timestamp": 1750000000000 }] }
```

Responds `{"received": 1, "total_stored": 42}`. Nothing reads that file yet.

## Project Structure

```
uBlockAI/
├── Makefile                       # setup, dev, and the CI gates
├── .pre-commit-config.yaml        # optional pre-commit equivalent of `make hooks`
├── .github/workflows/ci.yml
├── backend/
│   ├── app/
│   │   ├── main.py                # Flask app, CORS, JSON error handlers
│   │   ├── gunicorn.conf.py       # (backend/) gthread workers and timeouts
│   │   ├── api/routes.py          # the /api blueprint
│   │   ├── agents/
│   │   │   ├── langchain_agent.py # ReAct agent wrapper
│   │   │   └── prompts.py         # system prompt and generated JSON contract
│   │   ├── tools/
│   │   │   ├── registry.py        # tool list, and function defs derived from them
│   │   │   ├── web_search_tool.py
│   │   │   ├── credibility_tool.py
│   │   │   └── numeric_verify.py
│   │   ├── schemas/
│   │   │   ├── agent_io.py        # AgentOutput, ClaimInput, EvidenceInput
│   │   │   └── tool_io.py         # per-tool input/output models
│   │   ├── post_classifier.py     # OCR pipeline and its CLI
│   │   ├── auth.py                # API key auth
│   │   ├── rate_limit.py          # per-token limiter
│   │   ├── url_safety.py          # SSRF guard: scheme, port, host allowlist
│   │   ├── config.py              # validated settings snapshot
│   │   ├── llm.py                 # ChatOpenAI construction
│   │   ├── feedback_store.py      # newline-delimited report storage
│   │   ├── logging_config.py      # logging with payload redaction
│   │   ├── scripts/manage_api_keys.py
│   │   └── tests/
│   ├── gunicorn.conf.py
│   ├── requirements.txt           # exact runtime pins
│   ├── requirements-dev.txt
│   └── README.md
├── frontend/extension/
│   ├── manifest.json
│   ├── _locales/en/messages.json  # default-locale catalogue
│   ├── background.js              # service worker
│   ├── popup.html/.js/.css
│   ├── options.html/.js/.css
│   ├── icons/
│   └── src/
│       ├── script.js              # content script: scan loop only
│       ├── adapters/index.js      # per-platform DOM adapters
│       └── lib/                   # defaults, settings, payload, placeholder,
│                                 # cache, feedback, focus, i18n, and tests
├── scripts/
│   ├── dev_setup.py               # one-shot environment check
│   └── make_icons.py
└── README.md
```

## How It Works

1. **Content capture**: The content script finds posts through the adapter for
   the current platform, and reads each one's image, caption, permalink and -
   for video posts - its poster frame and video source
2. **Payload**: `buildAnalyzePayload` builds the request, with every field
   truncated to a shared limit
3. **Image processing**: For a Reel, the poster frame is used directly;
   otherwise the backend scrapes the post URL and follows the image references
   it finds
4. **OCR extraction**: Pillow preprocessing produces several variants, Tesseract
   runs across them in parallel, and the best-scoring text is merged
5. **Claim assembly**: Claims are drawn from the alt text, the caption and the
   OCR text, deduplicated, and guaranteed non-empty
6. **Verification**: The ReAct agent calls web search, credibility and numeric
   verification as needed
7. **Scoring**: The model returns a structured `AgentOutput`, validated against
   the Pydantic schema
8. **Flagging**: Posts over a threshold are blurred, replaced or removed, and the
   change is announced to screen readers

## Security Notes

- The backend fetches client-supplied URLs. `url_safety.validate_url` gates
  every outbound request: http/https only, ports 80/443 only, registrable
  domain on an allowlist, and private/loopback/link-local/reserved address
  space refused including after DNS resolution
- Analysis requires an API key; only its SHA-256 is stored
- CORS fails closed - an empty `ALLOWED_ORIGINS` blocks every browser origin
- Request bodies are capped at 8 MB
- Extensions are "run scripts" abuse targets: the warning panel is built with
  `textContent` and every URL goes through `safeUrl`, so model output and post
  markup cannot become script

## Known limitations

- **Videos are not decoded.** A Reel is analysed from its poster frame only.
  Frame sampling needs a media-decoding dependency (ffmpeg or PyAV) plus a
  per-request decode budget, and audio transcription needs an ASR model and its
  own consent story. Neither is in the critical path of a change whose only
  goal was to stop Reels being skipped. The reasoning is in
  `backend/app/post_classifier.py`
- **The scrape path is fragile.** Platforms increasingly answer logged-out
  requests with a login wall, so OCR often has nothing to work from. The
  poster-frame path sidesteps this for video; image posts still go through it
- **Feedback is write-only.** `/api/feedback` stores reports; nothing reads them
- **Scoring is not calibrated.** The thresholds are heuristics, not the output
  of an evaluation against labelled misinformation
- **The agent is a single ReAct loop**, not the multi-agent system this file
  previously described

## Future Roadmap

- [ ] **Frame sampling and audio transcription** for video posts, with a media
      pipeline and an ASR dependency budgeted for
- [ ] **Multi-Platform**: adapters for Facebook, X and TikTok
- [ ] **Inline image bytes**: hand the backend the image the extension already
      holds, instead of re-fetching it
- [ ] **Feedback loop**: something that reads the stored reports
- [ ] **Server-side result cache** keyed by normalized claim text and image hash
- [ ] **Offline mode**: basic fact-checking without API calls
- [ ] **Voice assistance** for the senior users this is built for

## Acknowledgments

Built during a hackathon with the goal of protecting vulnerable populations from AI-generated misinformation. The project demonstrates the power of tool-using LLM agents for content verification.

## Contact

For questions or contributions, please open an issue in the repository.

## License

The README previously stated "MIT License". There is no `LICENSE` file in this
repository, so no licence has actually been granted. Add one before relying on
that claim, or distributing the code.
