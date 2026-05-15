import os
from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException
from app.schemas.agent_io import AgentContext, AgentOutput, ClaimInput
from app.agents.langchain_agent import LangChainAgent
from app.post_classifier import extract_post_text_for_llm
import asyncio

router = APIRouter()

base_dir = os.path.dirname(os.path.abspath(__file__))
app_dir = os.path.dirname(base_dir)
env_path = os.path.join(app_dir, ".env")
load_dotenv(env_path)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY environment variable is not set")
print(f"Loaded OPENAI_API_KEY: {OPENAI_API_KEY is not None}")

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


@router.post("/analyze_claims", response_model=AgentOutput)
async def analyze_claims(payload: AnalyzeUrlRequest):
    agent_runner = LangChainAgent(api_key=OPENAI_API_KEY)
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
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/feedback")
async def submit_feedback(payload: FeedbackRequest):
    """Receive false-positive/negative reports from the extension for later analysis."""
    try:
        import json
        import datetime

        feedback_dir = os.path.join(app_dir, "feedback")
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

        return {"received": len(payload.reports), "total_stored": len(existing)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
