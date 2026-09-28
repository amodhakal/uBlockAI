"""HTTP API routes.

Request bodies are parsed and validated explicitly rather than being bound as
typed view arguments. Flask does not support Pydantic models as view
parameters, so the previous `async def analyze_claims(payload: AnalyzeUrlRequest)`
signature raised TypeError on every request: the view was invoked with no
arguments and the required `payload` parameter was never supplied.

Parsing in the view also lets a validation failure return 400 with a JSON body,
instead of Flask's default HTML error page.
"""

import asyncio
import functools
import os
import logging
from typing import Any, Callable, Dict, List, Optional, Type, TypeVar

from flask import Blueprint, abort, jsonify, request
from pydantic import BaseModel, Field, HttpUrl, ValidationError
from werkzeug.exceptions import HTTPException

from app.agents.langchain_agent import AgentOutputError, LangChainAgent
from app.auth import require_api_key
from app.cache import cache_key, get_cache
from app.config import get_settings
from app.feedback_store import append_reports
from app.image_bytes import (
    MAX_BASE64_CHARS,
    MAX_DIMENSION,
    MAX_INLINE_IMAGES,
    ImageRejected,
    decode_inline_images,
)
from app.post_classifier import extract_post_text_for_llm
from app.rate_limit import consume_rate_limit, require_rate_limit
from app.schemas.agent_io import AgentContext, ClaimInput
from app.url_safety import UnsafeUrlError

logger = logging.getLogger(__name__)

bp = Blueprint("api", __name__)

# Generic messages returned to clients. Exception text can contain internal
# paths, upstream URLs, prompt contents and API key fragments, so it is logged
# server-side only.
GENERIC_INTERNAL_ERROR = "Analysis failed due to an internal error."
GENERIC_VALIDATION_ERROR = "Request payload failed validation."
GENERIC_FEEDBACK_ERROR = "Could not record feedback."

MAX_CAPTION_CHARS = 5000
MAX_ALT_TEXT_CHARS = 2000
MAX_CLAIM_CHARS = 4000
# A poster frame is a URL, so it is bounded like one. The classifier re-checks
# this against its own limit; the field bound just keeps a huge string out of
# the request log and the agent's context.
MAX_VIDEO_THUMB_CHARS = 2048
# One screenful of posts, which is what the extension is trying to flag at once.
MAX_BATCH_ITEMS = 10

T = TypeVar("T", bound=BaseModel)


def json_body(model: Type[T]) -> Callable[[Callable[[T], Any]], Callable[[], Any]]:
    """Parse and validate the JSON request body into ``model``.

    A body that is absent, is not JSON, or violates the schema produces a 400
    with a JSON error body. The specific field errors are logged, not returned,
    so the response does not describe the server's internal models.
    """

    def decorator(view: Callable[[T], Any]) -> Callable[[], Any]:
        @functools.wraps(view)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            try:
                payload = request.get_json(force=True, silent=False)
            except Exception:
                logger.warning("request body was not valid JSON")
                abort(400, description=GENERIC_VALIDATION_ERROR)

            if payload is None:
                abort(400, description=GENERIC_VALIDATION_ERROR)

            try:
                parsed = model(**payload)
            except ValidationError as exc:
                logger.warning("payload validation error: %s", exc)
                abort(400, description=GENERIC_VALIDATION_ERROR)
            except TypeError as exc:
                logger.warning("payload was not a JSON object: %s", exc)
                abort(400, description=GENERIC_VALIDATION_ERROR)

            return await view(parsed, *args, **kwargs)

        return wrapper

    return decorator


class InlineImage(BaseModel):
    """An image supplied directly by the client rather than scraped.

    Every field is client-controlled and reaches Pillow, so the checks live in
    app.image_bytes: base64 validation, magic-byte verification against the
    declared type, a recomputed content hash, and a pixel budget.
    """

    mime_type: str = Field(..., pattern=r"^image/(jpeg|png|webp)$")
    data_base64: str = Field(..., max_length=MAX_BASE64_CHARS)
    content_sha256: str = Field(..., pattern=r"^[0-9a-fA-F]{64}$")
    width: Optional[int] = Field(default=None, ge=1, le=MAX_DIMENSION)
    height: Optional[int] = Field(default=None, ge=1, le=MAX_DIMENSION)
    # Provenance only. Never fetched, so it carries no SSRF risk; it is
    # shape-validated before being placed in the agent's context.
    source_url: Optional[str] = Field(default=None, max_length=2048)


class AnalyzeUrlRequest(BaseModel):
    url: str = Field(..., min_length=1, description="Post URL or direct image URL")
    caption: str = Field(default="", max_length=MAX_CAPTION_CHARS)
    alt_text: str = Field(default="", max_length=MAX_ALT_TEXT_CHARS)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    request_id: Optional[str] = None
    max_images: int = Field(default=3, ge=1, le=10)
    # Set by the extension when the post is a Reel or video post. `video_thumb`
    # is that video's poster frame, which is what gets OCR'd: the video itself
    # is never fetched or decoded, because doing so needs a media-decoding
    # dependency and an ASR model that this service does not carry. See the
    # "Video and Reel posts" note in app/post_classifier.py.
    is_video: bool = False
    video_thumb: str = Field(default="", max_length=MAX_VIDEO_THUMB_CHARS)
    # When present, these replace the scrape entirely. `images` wins over
    # `video_thumb`: inline bytes are the more trustworthy of the two,
    # because the client is handing over exactly what it rendered.
    images: List[InlineImage] = Field(
        default_factory=list, max_length=MAX_INLINE_IMAGES
    )


class FeedbackReport(BaseModel):
    type: str
    imageUrl: str
    caption: str = Field(default="", max_length=MAX_CAPTION_CHARS)
    timestamp: int


class AnalyzeBatchRequest(BaseModel):
    # Bounded so one request cannot fan out into an unbounded number of
    # analyses. The body size cap in main.py bounds the bytes; this bounds
    # what those bytes can cost.
    items: List[AnalyzeUrlRequest] = Field(
        ..., min_length=1, max_length=MAX_BATCH_ITEMS, description="Posts to analyze"
    )


class FeedbackRequest(BaseModel):
    reports: List[FeedbackReport]


def build_claims(payload: AnalyzeUrlRequest, ocr_text: str) -> List[str]:
    """Assemble the claim list the agent will verify.

    Previously the claim list was built from alt text alone:

        claims=[payload.alt_text]

    Alt text is frequently empty on real posts. When it was, ClaimInput's
    ``min_length=1`` constraint on the claims list failed validation and the
    request died with an HTTP 500, so an ordinary post with no alt text could
    not be analyzed at all.

    The caption and the OCR text are the actual carriers of misinformation in a
    social post, and both were being passed only as passive context that the
    agent was not required to verify. Claims are now drawn from all three
    sources, deduplicated, and guaranteed non-empty.
    """
    candidates = [
        (payload.alt_text or "").strip(),
        (payload.caption or "").strip(),
        (ocr_text or "").strip(),
    ]

    claims: List[str] = []
    seen: set[str] = set()
    for text in candidates:
        if not text:
            continue
        clipped = text[:MAX_CLAIM_CHARS]
        key = clipped.lower()
        if key in seen:
            continue
        seen.add(key)
        claims.append(clipped)

    if not claims:
        # ClaimInput requires at least one claim. A post with no caption, no
        # alt text and no OCR output is a legitimate, if empty, request; the
        # agent can still return an "unverifiable" verdict against an explicit
        # placeholder rather than the request 500ing.
        claims = ["[no extractable text in this post]"]

    return claims


@bp.get("/health")
async def health():
    """Liveness and readiness probe.

    Reports whether configuration resolved, so a container orchestrator can
    distinguish "process is up" from "process is up but misconfigured". It never
    echoes a key or any other secret: the API key is reported as a boolean.
    """
    settings = get_settings()
    checks = {
        "api_key_configured": bool(settings.openai_api_key),
        "search_provider_configured": bool(settings.brave_api_key),
        "feedback_dir_writable": os.access(settings.feedback_dir, os.W_OK)
        if settings.feedback_dir.exists()
        else os.access(settings.feedback_dir.parent, os.W_OK),
    }

    # A missing API key is a configuration fault, not a crash: the process is
    # alive but cannot serve analysis requests.
    healthy = checks["api_key_configured"]
    return (
        jsonify(
            {
                "status": "ok" if healthy else "degraded",
                "version": "1.0.0",
                "model": settings.openai_model,
                "checks": checks,
            }
        ),
        200 if healthy else 503,
    )


async def run_analysis(payload: AnalyzeUrlRequest) -> tuple[Dict[str, Any], str]:
    """Analyze one post. Returns ``(response body, cache status)``.

    Shared by the single and batch endpoints so the two cannot drift: the
    cache lookup, the inline-image validation, the OCR scrape and the agent run
    are identical in both. Failures are raised, not returned, so the single
    endpoint can map them to status codes and the batch endpoint can attribute
    them to one item.
    """
    settings = get_settings()
    agent_runner = LangChainAgent(api_key=settings.openai_api_key)
    request_id = payload.request_id or "auto"
    logger.debug(
        "analysis requested request_id=%s url=%s caption_chars=%d alt_text_chars=%d "
        "max_images=%d inline_images=%d is_video=%s",
        request_id,
        payload.url,
        len(payload.caption or ""),
        len(payload.alt_text or ""),
        payload.max_images,
        len(payload.images),
        payload.is_video,
    )

    # Checked before any OCR, image decode or agent work: the point of the
    # cache is to skip the expensive path entirely, and decoding the images
    # to discover they are the same images we already answered would defeat
    # it. The key is content-addressed, so this is safe for inline images;
    # the URL is part of the key when it is not, because the OCR text is
    # unknown until after the scrape.
    key = cache_key(
        url=payload.url,
        caption=payload.caption,
        alt_text=payload.alt_text,
        images=payload.images,
        max_images=payload.max_images,
        settings=settings,
    )
    cache = get_cache(settings)
    cached = cache.get(key)
    if cached is not None:
        logger.info(
            "analysis cache hit request_id=%s verdict=%s",
            request_id,
            cached.get("verdict"),
        )
        return cached, "HIT"

    # Decoding and verification happen before the agent, off the event loop
    # because Pillow decode is CPU-bound.
    decoded = await asyncio.to_thread(decode_inline_images, payload.images)

    ocr_res = await asyncio.to_thread(
        extract_post_text_for_llm,
        post_url=payload.url,
        caption=payload.caption,
        alt_text=payload.alt_text,
        max_images=payload.max_images,
        # Only a video post's poster is a substitute for the scrape. An
        # image post that happens to send video_thumb does not get it used.
        # Inline bytes take precedence: the client already holds the pixels,
        # so there is nothing to fetch at all.
        poster_url=payload.video_thumb if payload.is_video else "",
        images=decoded,
    )
    llm_input_text = ocr_res.get("llm-input-text", "") or ""
    # The agent scores AI-generated media, and a deepfake Reel and a doctored
    # still are different problems, so it is told which one it is looking at.
    # Client metadata is preserved rather than replaced.
    metadata = {**(payload.metadata or {}), "is_video": payload.is_video}
    # AgentContext.urls is typed HttpUrl, so build it through the model
    # rather than handing Pydantic a bare list of strings to coerce.
    context = AgentContext(
        caption=payload.caption or "",
        ocr_text=llm_input_text,
        metadata=metadata,
    )
    context.urls = [HttpUrl(payload.url)]
    claim_input = ClaimInput(
        claims=build_claims(payload, llm_input_text),
        context=context,
        request_id=request_id,
    )
    result = await agent_runner.run(claim_input)
    logger.info(
        "analysis complete request_id=%s verdict=%s misinfo=%.2f ai=%.2f tool_rounds=%d",
        request_id,
        result.verdict.value,
        result.misinformation_risk_score,
        result.ai_generated_risk_score,
        result.tool_rounds,
    )
    body = result.model_dump()
    # Only successes are cached: storing a 502 would make a transient
    # upstream failure sticky for the whole TTL.
    cache.set(key, body)
    return body, "MISS"


@bp.post("/analyze_claims")
@require_api_key
@require_rate_limit("analyze")
@json_body(AnalyzeUrlRequest)
async def analyze_claims(payload: AnalyzeUrlRequest):
    request_id = payload.request_id or "auto"
    try:
        body, cache_status = await run_analysis(payload)
        response = jsonify(body)
        response.headers["X-Cache"] = cache_status
        return response
    except ImageRejected as exc:
        # 400: the client sent something unacceptable. The message names the
        # rule, never the payload.
        logger.info("inline image rejected request_id=%s: %s", request_id, exc)
        abort(400, description=f"Supplied image rejected: {exc}")
    except UnsafeUrlError as exc:
        logger.info("post url rejected request_id=%s: %s", request_id, exc)
        abort(400, description=f"Post URL rejected: {exc}")
    except ValidationError as exc:
        logger.warning("analysis validation error request_id=%s: %s", request_id, exc)
        abort(400, description=GENERIC_VALIDATION_ERROR)
    except AgentOutputError as exc:
        logger.error("agent output error request_id=%s: %s", request_id, exc)
        abort(502, description=GENERIC_INTERNAL_ERROR)
    except HTTPException:
        raise
    except Exception:
        # Log the real cause; return nothing that describes it.
        logger.exception("analysis failed request_id=%s", request_id)
        abort(500, description=GENERIC_INTERNAL_ERROR)


def _batch_error(
    index: int, request_id: str, status: str, message: str
) -> Dict[str, Any]:
    """One failed batch item.

    The message is the same generic text the single endpoint would return for
    that class of failure: naming the rule is allowed, describing the server's
    internals or echoing the payload is not.
    """
    return {
        "index": index,
        "request_id": request_id,
        "status": status,
        "error": message,
    }


@bp.post("/analyze_batch")
@require_api_key
@json_body(AnalyzeBatchRequest)
async def analyze_batch(payload: AnalyzeBatchRequest):
    """Analyze up to MAX_BATCH_ITEMS posts in one round trip.

    A screenful of posts is otherwise MAX_BATCH_ITEMS round trips, each paying
    the extension's per-request latency while the user watches a spinner.

    Every item is analyzed independently and reported independently. One bad
    URL or one malformed image does not fail the batch: the extension needs
    verdicts for the posts it can analyze, and discarding eight good answers
    because the ninth post had a bad hash is the wrong trade. Each entry
    carries its own status, so a partial result is still actionable.

    Items run sequentially. Ten concurrent agent runs would multiply the LLM
    concurrency of a single request by ten on top of the per-token rate
    limit, and the response has to wait for the slowest item either way.
    """
    # Charged up front, one token per item, against the same "analyze" group
    # the single endpoint uses. The decorator is deliberately not used here:
    # one token per request would make a batch of ten a ten-fold cost
    # multiplier, and "batching must not be cheaper per analysis" is the whole
    # reason the two endpoints share a group.
    consume_rate_limit("analyze", units=len(payload.items))

    results: List[Dict[str, Any]] = []
    all_cached = True
    for index, item in enumerate(payload.items):
        request_id = item.request_id or f"batch-{index}"
        try:
            body, cache_status = await run_analysis(item)
        except ImageRejected as exc:
            logger.info(
                "batch image rejected index=%d request_id=%s: %s",
                index,
                request_id,
                exc,
            )
            results.append(
                _batch_error(
                    index, request_id, "invalid", f"Supplied image rejected: {exc}"
                )
            )
        except UnsafeUrlError as exc:
            logger.info(
                "batch url rejected index=%d request_id=%s: %s", index, request_id, exc
            )
            results.append(
                _batch_error(index, request_id, "invalid", f"Post URL rejected: {exc}")
            )
        except ValidationError as exc:
            logger.warning(
                "batch validation error index=%d request_id=%s: %s",
                index,
                request_id,
                exc,
            )
            results.append(
                _batch_error(index, request_id, "invalid", GENERIC_VALIDATION_ERROR)
            )
        except AgentOutputError as exc:
            logger.error(
                "batch agent output error index=%d request_id=%s: %s",
                index,
                request_id,
                exc,
            )
            results.append(
                _batch_error(index, request_id, "error", GENERIC_INTERNAL_ERROR)
            )
        except HTTPException:
            raise
        except Exception:
            logger.exception(
                "batch item failed index=%d request_id=%s", index, request_id
            )
            results.append(
                _batch_error(index, request_id, "error", GENERIC_INTERNAL_ERROR)
            )
        else:
            all_cached = all_cached and cache_status == "HIT"
            results.append(
                {
                    "index": index,
                    "request_id": request_id,
                    "status": "ok",
                    "cache": cache_status,
                    "result": body,
                }
            )

    failed = sum(1 for entry in results if entry["status"] != "ok")
    logger.info(
        "batch complete items=%d failed=%d all_cached=%s",
        len(results),
        failed,
        all_cached,
    )
    response = jsonify({"results": results})
    # HIT only when every item was served from cache, so the header cannot
    # overstate what happened.
    response.headers["X-Cache"] = "HIT" if all_cached and results else "MISS"
    return response


@bp.post("/feedback")
@require_api_key
@require_rate_limit("feedback")
@json_body(FeedbackRequest)
async def submit_feedback(payload: FeedbackRequest):
    """Receive false-positive/negative reports from the extension for later analysis."""
    try:
        total = await asyncio.to_thread(
            append_reports,
            get_settings().feedback_dir,
            [report.model_dump() for report in payload.reports],
        )
        return jsonify({"received": len(payload.reports), "total_stored": total})
    except ValidationError as exc:
        logger.warning("feedback validation error: %s", exc)
        abort(400, description=GENERIC_VALIDATION_ERROR)
    except HTTPException:
        raise
    except Exception:
        logger.exception("feedback submission failed")
        abort(500, description=GENERIC_FEEDBACK_ERROR)
