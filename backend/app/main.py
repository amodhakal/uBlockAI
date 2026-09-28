import logging
import os

from dotenv import load_dotenv
from flask import Flask, jsonify
from flask_cors import CORS
from pydantic import ValidationError
from werkzeug.exceptions import BadRequest, HTTPException

from app.api.routes import bp as api_bp
from app.config import get_settings
from app.logging_config import configure_logging
from app.rate_limit import (  # noqa: E402  (import after logging is configured)
    RateLimitExceeded,
    current_decision,
)

base_dir = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.join(base_dir, ".env")
load_dotenv(env_path)

# Debug is opt-in via DEBUG=true. Privacy-sensitive payload content is
# redacted by the logging filter regardless of level.
configure_logging()

logger = logging.getLogger(__name__)

app = Flask(__name__)

settings = get_settings()

# Fail closed. The previous default was `or ["*"]`, which is wide-open CORS on a
# service that spends money per request. An empty allowlist means flask-cors
# emits no Access-Control-Allow-Origin, so browsers block every origin.
#
# Extension origins look like chrome-extension://<id>, not https://. The id
# differs between a locally-loaded unpacked build and a store build, so
# operators must add their own after loading the extension. See the README.
origins = list(settings.allowed_origins)
if not origins:
    logger.warning(
        "ALLOWED_ORIGINS is empty, so no browser origin may call this API. "
        "Set it to your extension id, e.g. "
        "ALLOWED_ORIGINS=chrome-extension://abcdef...,https://your-frontend"
    )

CORS(
    app,
    origins=origins,
    allow_headers=["Content-Type", "Authorization", "X-API-Key"],
    methods=["GET", "POST", "OPTIONS"],
    # So a throttled client can read its budget and back off before it hits 429.
    expose_headers=[
        "X-RateLimit-Limit",
        "X-RateLimit-Remaining",
        "X-RateLimit-Reset",
        "Retry-After",
    ],
    max_age=600,
)

# A request body is parsed with request.get_json, so cap it before that happens.
# Base64 image ingestion needs room, but an unbounded body is a memory DoS.
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024

app.register_blueprint(api_bp, url_prefix="/api")


@app.after_request
def stamp_rate_limit_headers(response):
    """Report the caller's remaining budget on success as well as on 429.

    A well-behaved client can then back off before it is throttled, instead of
    discovering the limit by being rejected.
    """
    decision = current_decision()
    if decision is None:
        return response
    for key, value in decision.headers().items():
        response.headers.setdefault(key, value)
    return response


@app.errorhandler(RateLimitExceeded)
def handle_rate_limit(exc: RateLimitExceeded):
    """429 with Retry-After and the budget headers.

    Registered explicitly because the generic HTTPException handler would
    swallow the status headers.
    """
    response = jsonify({"error": exc.description})
    response.status_code = 429
    response.headers["Retry-After"] = str(exc.retry_after)
    response.headers["X-RateLimit-Limit"] = str(exc.limit)
    response.headers["X-RateLimit-Remaining"] = str(exc.remaining)
    response.headers["X-RateLimit-Reset"] = str(exc.retry_after)
    return response


@app.errorhandler(BadRequest)
def handle_bad_request(exc: BadRequest):
    """Malformed or schema-violating request bodies are the client's fault.

    Flask raises BadRequest when a view's Pydantic argument cannot be bound,
    which covers a missing field, a wrong type and a body that is not JSON at
    all. Unhandled, these surfaced as HTML error pages with no JSON body, so
    the extension could not read the failure.
    """
    app.logger.warning("bad request: %s", exc)
    return jsonify({"error": "Request payload failed validation."}), 400


@app.errorhandler(ValidationError)
def handle_pydantic_validation_error(exc: ValidationError):
    app.logger.warning("payload validation error: %s", exc)
    return jsonify({"error": "Request payload failed validation."}), 400


@app.errorhandler(HTTPException)
def handle_http_exception(exc: HTTPException):
    """Return a JSON body for every HTTP error, and never leak internals."""
    return (
        jsonify({"error": exc.description or exc.name}),
        exc.code or 500,
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=settings.debug)
