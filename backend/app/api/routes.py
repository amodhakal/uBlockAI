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
import logging
from typing import Any, Callable, Dict, List, Optional, Type, TypeVar

from flask import Blueprint, abort, jsonify, request
from pydantic import BaseModel, Field, HttpUrl, ValidationError
from werkzeug.exceptions import HTTPException

from app.agents.langchain_agent import AgentOutputError, LangChainAgent
from app.config import get_settings
from app.feedback_store import append_reports
from app.post_classifier import extract_post_text_for_llm
from app.schemas.agent_io import AgentContext, ClaimInput

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


class AnalyzeUrlRequest(BaseModel):
    url: str = Field(..., min_length=1, description="Post URL or direct image URL")
    caption: str = Field(default="", max_length=MAX_CAPTION_CHARS)
    alt_text: str = Field(default="", max_length=MAX_ALT_TEXT_CHARS)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    request_id: Optional[str] = None
    max_images: int = Field(default=3, ge=1, le=10)


class FeedbackReport(BaseModel):
    type: str
    imageUrl: str
    caption: str = Field(default="", max_length=MAX_CAPTION_CHARS)
    timestamp: int


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


@bp.post("/analyze_claims")
@json_body(AnalyzeUrlRequest)
async def analyze_claims(payload: AnalyzeUrlRequest):
    settings = get_settings()
    agent_runner = LangChainAgent(api_key=settings.openai_api_key)
    request_id = payload.request_id or "auto"
    logger.debug(
        "analysis requested request_id=%s url=%s caption_chars=%d alt_text_chars=%d max_images=%d",
        request_id,
        payload.url,
        len(payload.caption or ""),
        len(payload.alt_text or ""),
        payload.max_images,
    )
    try:
        ocr_res = await asyncio.to_thread(
            extract_post_text_for_llm,
            post_url=payload.url,
            caption=payload.caption,
            alt_text=payload.alt_text,
            max_images=payload.max_images,
        )
        llm_input_text = ocr_res.get("llm-input-text", "") or ""
        # AgentContext.urls is typed HttpUrl, so build it through the model
        # rather than handing Pydantic a bare list of strings to coerce.
        context = AgentContext(
            caption=payload.caption or "",
            ocr_text=llm_input_text,
            metadata=payload.metadata or {},
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
        return jsonify(result.model_dump())
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


@bp.post("/feedback")
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
