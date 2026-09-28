import os
from dotenv import load_dotenv
from flask import Blueprint, jsonify, abort
from app.config import APP_DIR, get_settings
from app.schemas.agent_io import AgentContext, AgentOutput, ClaimInput
from app.agents.langchain_agent import LangChainAgent
from app.post_classifier import extract_post_text_for_llm
import asyncio

bp = Blueprint("api", __name__)

from pydantic import BaseModel
from typing import Any, Dict, List, Optional


class AnalyzeUrlRequest(BaseModel):
    url: str
    caption: str = ""
    alt_text: str = ""
    metadata: Dict[str, Any] = {}
    request_id: Optional[str] = None
    max_images: int = 3


class FeedbackReport(BaseModel):
    type: str
    imageUrl: str
    caption: str = ""
    timestamp: int


class FeedbackRequest(BaseModel):
    reports: List[FeedbackReport]


@bp.post("/analyze_claims")
async def analyze_claims(payload: AnalyzeUrlRequest):
    settings = get_settings()
    agent_runner = LangChainAgent(api_key=settings.openai_api_key)
    try:
        ocr_res = await asyncio.to_thread(
            extract_post_text_for_llm,
            post_url=payload.url,
            caption=payload.caption,
            alt_text=payload.alt_text,
            max_images=payload.max_images,
        )
        llm_input_text = ocr_res.get("llm-input-text", "") or ""
        claim_input = ClaimInput(
            claims=[payload.alt_text],
            context={
                "caption": payload.caption or "",
                "ocr_text": llm_input_text,
                "urls": [payload.url],
                "metadata": payload.metadata or {},
            },
            request_id=payload.request_id or "auto",
        )
        result = await agent_runner.run(claim_input)
        return jsonify(result.model_dump())
    except Exception as e:
        abort(500, description=str(e))


@bp.post("/feedback")
async def submit_feedback(payload: FeedbackRequest):
    """Receive false-positive/negative reports from the extension for later analysis."""
    try:
        import json
        import datetime

        feedback_dir = str(get_settings().feedback_dir)
        os.makedirs(feedback_dir, exist_ok=True)
        filename = datetime.datetime.now().strftime("%Y-%m-%d.json")
        filepath = os.path.join(feedback_dir, filename)

        existing = []
        if os.path.exists(filepath):
            with open(filepath, "r") as f:
                existing = json.load(f)

        for report in payload.reports:
            existing.append(report.model_dump())

        with open(filepath, "w") as f:
            json.dump(existing, f, indent=2)

        return jsonify({"received": len(payload.reports), "total_stored": len(existing)})
    except Exception as e:
        abort(500, description=str(e))