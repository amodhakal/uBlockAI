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
OPENAI_TEMPERATURE=0.0
BRAVE_API_KEY=...          # optional; enables Brave Search instead of the DDG fallback
ALLOWED_ORIGINS=chrome-extension://<your-extension-id>
OCR_PROFILE=fast           # or accurate
MAX_IMAGES=3
API_KEYS_PATH=app/api_keys.json
REQUIRE_AUTH=true          # the only way to disable auth; it fails closed
ANALYZE_RATE_LIMIT=20
FEEDBACK_RATE_LIMIT=60
RATE_WINDOW_SECONDS=60
CACHE_TTL_SECONDS=3600     # 0 disables the analysis cache
CACHE_MAX_ENTRIES=256
DEBUG=false
```

Feedback is written to `backend/app/feedback/`, which is fixed rather than
configurable. `backend/gunicorn.conf.py` reads its own set: `GUNICORN_BIND`,
`GUNICORN_WORKERS`, `GUNICORN_THREADS`, `GUNICORN_RELOAD`,
`GUNICORN_WORKER_CONNECTIONS`, `GUNICORN_KEEPALIVE`, `GUNICORN_MAX_REQUESTS`,
`GUNICORN_MAX_REQUESTS_JITTER`, `GUNICORN_ACCESS_LOG`, `GUNICORN_ERROR_LOG`,
`GUNICORN_LOG_LEVEL`, `ANALYSIS_TIMEOUT_SECONDS` (180) and
`GRACEFUL_TIMEOUT_SECONDS` (30).

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
serve several analyses at once, and Gunicorn's own 30-second default timeout would kill
legitimate requests mid-analysis, so the checked-in config raises it to 180s
(`ANALYSIS_TIMEOUT_SECONDS`).

```bash
cd backend
.venv/bin/gunicorn -c gunicorn.conf.py app.main:app
```

The `-c` flag is what loads `gunicorn.conf.py`; it is not picked up
automatically. Defaults are `workers=min(cpu,4)`, `threads=min(16,cpu*2)` and
`timeout=180`. Note that the rate limiter *and* the analysis cache are per
worker, so the effective global rate limit is `workers x threads x
ANALYZE_RATE_LIMIT` and a cold deployment sees a cache hit rate of roughly
`1/workers`. The config logs that arithmetic on startup.

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

Output is JSON with `llm-input-text` (caption + alt text + OCR text, combined),
`caption` and `alt-text`, plus `ocr-errors` when an image failed OCR.

### Using the Extension

1. Open Instagram or Threads and scroll; posts are analysed as they appear
2. Posts over a threshold are blurred, replaced with a warning panel, or removed.
   Defaults are 0.3 for AI-generated risk, 0.2 for misinformation, and the
   `placeholder` action. A post is hidden if *either* score reaches its threshold
3. **Show post anyway** reveals a post and remembers the decision, which also
   spares it from the pre-filter on later visits
4. **Report mistake** files a false-positive report. Unflagged posts carry their
   own report control, so a missed detection can be filed as a false negative.
   Both are queued locally and drained on an alarm
5. Click the toolbar icon for thresholds, the hiding action, statistics, text
   size and the telemetry opt-in; **Advanced settings** opens the options page
   for the backend URL, API key, trust list and a **Test connection** button that
   calls `GET /api/health`

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
| `credibility_weighted_support` | float or null | Share of total source weight supporting the claim, recomputed server-side; `null` when no evidence carried a usable tier |
| `tool_rounds` | int | Diagnostic only |

### Undocumented response headers

- `X-Cache: HIT|MISS` on both analysis endpoints
- `X-RateLimit-Limit`, `-Remaining` and `-Reset` on *successful* responses, not
  only on 429, so a well-behaved client can back off before it is throttled.
  All four budget headers are CORS-exposed for the same reason

There is no `ai_score`, `misinformation_score` or `reasoning` key. Those were
the names this section used to document, and nothing has ever emitted them.

`credibility_weighted_support` is not the model's to report. The agent chooses a
tier per source and the code applies the weight: high `1.0`, medium `0.5`, low
`0.2`, unrated `0.0`. That support share is blended 50/50 with the model's own
score and the correction is clamped to ±0.15, with an audit line appended to
`reasoning_chain`. A verdict that moved without a trail would be worse than one
that did not move at all.

Responses also carry `X-Cache: HIT|MISS`. A `HIT` skips OCR and the agent
entirely. The batch endpoint reports `HIT` only when *every* item was cached, so
the header cannot overstate what happened.

#### `POST /api/analyze_batch`

Analyses up to 10 posts in one round trip. Requires an API key.

```json
{ "items": [ { "url": "https://...", "caption": "a claim" } ] }
```

Every item is analysed and reported independently, so one bad URL does not
discard nine good answers — a partial failure is still HTTP 200:

```json
{ "results": [
    { "index": 0, "request_id": "auto", "status": "ok", "cache": "MISS", "result": { } },
    { "index": 1, "request_id": "auto", "status": "invalid", "error": "Supplied image rejected: ..." }
] }
```

Items run sequentially on purpose: ten concurrent agent runs would multiply LLM
concurrency by ten on top of the per-token limit, and the response waits for the
slowest item regardless. The batch is charged one rate-limit token per item
against the same `analyze` group the single endpoint uses, so batching cannot be
cheaper per analysis.

The shipped extension does not call this endpoint yet; it still issues one
request per post, bounded to four concurrent.

#### `POST /api/analyze_claims/stream`

Server-Sent Events over the same pipeline, additive alongside the JSON
endpoint. Stages are `received`, `decoding`, `ocr`, `searching`, `credibility`,
`verifying`, `synthesis`, `done`, and `error`.

The stages are observed, not scheduled. `searching`, `credibility` and
`verifying` are emitted only when the agent graph genuinely invoked that tool,
and a run answered from the caption alone never emits `searching` — the UI must
not report work that did not happen. `run` and `stream_run` share the same
compiled graph and the same output projection, so the two paths cannot diverge.
A bare `:` comment every 10s keeps intermediaries from reaping the connection
during a long tool call, and `X-Accel-Buffering: no` stops Nginx from buffering
the whole response.

#### Inline image bytes

`images` is an optional list of at most 3 objects, and when present it replaces
the scrape entirely — the request performs no fetch, so the SSRF surface is
never consulted:

| Field | Type | Notes |
|---|---|---|
| `mime_type` | string | `image/jpeg`, `image/png` or `image/webp` |
| `data_base64` | string | ≤ 4,000,000 chars |
| `content_sha256` | string | Must equal the SHA-256 of the decoded bytes |
| `width`, `height` | int, optional | 1–4096; advisory, and a mismatch is rejected |
| `source_url` | string, optional | Provenance only, never fetched |

Validation happens in `app/image_bytes.py`: base64 decoded with `validate=True`,
magic bytes checked against the *declared* type, SHA-256 recomputed, per-axis
dimension ≤ 4096 and a total pixel budget of 4096×3072 so a decompression bomb
with legal dimensions is still refused. Precedence is `images` > `video_thumb` >
scrape, and `video_thumb` is only honoured when `is_video` is true.

The shipped extension does not send `images` yet; the path exists for any API
caller.

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
│   │   ├── image_bytes.py         # inline image validation
│   │   ├── auth.py                # API key auth
│   │   ├── rate_limit.py          # per-token limiter
│   │   ├── url_safety.py          # SSRF guard: scheme, port, host allowlist
│   │   ├── cache.py               # TTL+LRU analysis result cache
│   │   ├── progress.py            # SSE stage names and their provenance
│   │   ├── config.py              # validated settings snapshot
│   │   ├── llm.py                 # ChatOpenAI construction
│   │   ├── feedback_store.py      # newline-delimited report storage
│   │   ├── feedback/              # where those reports land
│   │   ├── logging_config.py      # logging with payload redaction
│   │   ├── scripts/manage_api_keys.py
│   │   └── tests/
│   ├── gunicorn.conf.py
│   ├── pyproject.toml             # ruff, mypy and pytest config
│   ├── requirements.txt           # exact runtime pins
│   ├── requirements.lock
│   ├── requirements-dev.txt
│   ├── scripts/install_hooks.py   # what `make hooks` runs
│   └── README.md
├── frontend/extension/
│   ├── manifest.json
│   ├── _locales/en/messages.json  # default-locale catalogue
│   ├── background.js              # service worker
│   ├── popup.html/.js/.css
│   ├── options.html/.js/.css
│   ├── package.json
│   ├── eslint.config.js
│   ├── icons/
│   └── src/
│       ├── script.js              # content script: scan loop only
│       ├── adapters/index.js      # per-platform DOM adapters
│       └── lib/                   # defaults, settings, payload, placeholder,
│                                 # cache, counters, concurrency, persistence,
│                                 # retry, prefilter, progress, claim-scores,
│                                 # explanation, sanitize, dommap, focus, i18n,
│                                 # trust, feedback, telemetry, logging,
│                                 # tokenizer, onnx-session, local-classifier,
│                                 # offline, and tests
├── scripts/
│   ├── dev_setup.py               # one-shot environment check
│   └── make_icons.py
└── README.md
```

## How It Works

1. **Pre-filter**: Before anything is sent, the client decides whether there is
   anything to check. It is deliberately asymmetric — skipping a post that
   mattered is a correctness failure, skipping one that didn't costs a little
   CPU — so every rule is written to be wrong in the cheap direction, and it
   fails open on anything it cannot evaluate. Non-Latin captions are let
   through rather than measured with a Latin-calibrated rule, and any post with
   an image skips the text rules entirely, because the backend OCRs images
2. **Trust list**: Posts the user revealed with "Show post anyway" are
   remembered and short-circuit the pre-filter
3. **Content capture**: The content script finds posts through the adapter for
   the current platform, and reads each one's image, caption, permalink and -
   for video posts - its poster frame and video source
4. **Payload**: `buildAnalyzePayload` builds the request, with the caption
   truncated to 3000 characters and alt text to 1000
5. **Image processing**: Inline `images` win, then a Reel's poster frame, then
   the scrape
6. **OCR extraction**: Pillow preprocessing produces several variants, Tesseract
   runs across them in parallel, and the best-scoring text is merged
7. **Claim assembly**: Claims are drawn from the alt text, the caption and the
   OCR text, deduplicated, and guaranteed non-empty
8. **Verification**: The ReAct agent calls web search, credibility and numeric
   verification as needed
9. **Scoring**: The model returns a structured `AgentOutput`, validated against
   the Pydantic schema, and the credibility weighting is then recomputed in code
10. **Flagging**: Posts over a threshold are blurred, replaced or removed, and
    the change is announced to screen readers

**Offline mode** short-circuits step 4 onwards. When it is on, the client
classifies locally and never contacts the service, and the warning panel is
labelled as an on-device estimate rather than a verdict. The shipped default is a
dependency-free heuristic lexical scorer; an ONNX checkpoint can be dropped in
to replace it, and when neither is available the heuristic runs rather than the
panel claiming a confidence it cannot justify. See `docs/models/README.md`.

**Progress** is streamed over a long-lived port rather than a one-shot message,
because a content script cannot read a cross-origin body and a 20–60s analysis
cannot fit in one response. Disconnecting the port aborts the request, which is
how cancelling works. If the backend has no stream, the client falls back to the
plain request and shows generic waiting wording rather than stage names it will
never receive.

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
- Telemetry is off by default, and off means off: while disabled the payload
  builder returns `null`, so the network path is unreachable rather than merely a
  no-op. When enabled it sends three integer counters — analysed, hidden,
  reported — from an explicit allowlist. Captions, alt text, image URLs and post
  keys are never included, and a new field has to be added deliberately rather
  than arriving with a spread. The `/api/telemetry` endpoint the client targets
  does not exist on this backend yet, so uploads record a 404 and stop; the
  local counters keep working
- The extension requests only `storage` and `alarms` as API permissions. Host
  access is the two platforms plus the hosted backend, with `https://*/*` and
  loopback as *optional* permissions requested only when the user points the
  extension at their own backend

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
- **Offline mode classifies on a heuristic by default.** No model weights are
  committed to this repository — a 60–110 MB checkpoint would be unauditable, and
  its licence is not this project's to grant. An ONNX model can be dropped in
  and the runtime will use it; until then the lexical scorer runs, and it
  reports a self-assessed confidence rather than a calibrated one
- **The SSRF guard is check-then-use.** It resolves every A/AAAA record and
  refuses if any answer is private, which mitigates DNS rebinding, but the
  resolved address is not pinned to the subsequent connection
- **The trust list and the hidden-key set are stored in `chrome.storage.sync`**,
  which is not end-to-end encrypted, and are bounded to 400 entries to stay
  inside the 8 KB per-item quota. Post keys are CDN-derived, so they are
  identifying; the API key is deliberately kept out of sync storage for the same
  reason

## Future Roadmap

- [ ] **Frame sampling and audio transcription** for video posts, with a media
      pipeline and an ASR dependency budgeted for
- [ ] **Multi-Platform**: adapters for Facebook, X and TikTok. Instagram,
      Threads and a generic fallback ship today
- [ ] **Feedback loop**: something that reads the stored reports. They are
      written and nothing reads them
- [ ] **A backend for `/api/telemetry`**, so the client half has a server half
- [ ] **Wiring the client to `/api/analyze_batch`** and to inline `images`, both
      of which the backend already implements
- [ ] **Shipping an ONNX checkpoint**, so offline mode upgrades from the
      heuristic scorer to a real model
- [ ] **Voice assistance** for the senior users this is built for

The inline image path, the result cache and offline mode used to be on this
list. They shipped; the entries above are what genuinely remains.

## Acknowledgments

Built during a hackathon with the goal of protecting vulnerable populations from AI-generated misinformation. The project demonstrates the power of tool-using LLM agents for content verification.

## Contact

For questions or contributions, please open an issue in the repository.

## License

The README previously stated "MIT License". There is no `LICENSE` file in this
repository, so no licence has actually been granted. Add one before relying on
that claim, or distributing the code.
