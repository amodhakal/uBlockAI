import os

from dotenv import load_dotenv
from flask import Flask, jsonify
from flask_cors import CORS
from pydantic import ValidationError
from werkzeug.exceptions import BadRequest, HTTPException

from app.api.routes import bp as api_bp
from app.config import get_settings
from app.logging_config import configure_logging

base_dir = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.join(base_dir, ".env")
load_dotenv(env_path)

# Debug is opt-in via DEBUG=true. Privacy-sensitive payload content is
# redacted by the logging filter regardless of level.
configure_logging()

app = Flask(__name__)

settings = get_settings()
origins = list(settings.allowed_origins) or ["*"]
CORS(
    app,
    origins=origins,
    allow_headers=["Content-Type", "Authorization", "X-API-Key"],
    methods=["GET", "POST", "OPTIONS"],
)

app.register_blueprint(api_bp, url_prefix="/api")


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
