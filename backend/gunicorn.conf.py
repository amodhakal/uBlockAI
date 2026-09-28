"""Gunicorn configuration for the uBlockAI backend.

The service is an async Flask app driving a multi-second LLM pipeline with OCR
in the middle. The default configuration is wrong for that in two important ways.

Worker class
    The views are ``async def``. Gunicorn's default ``sync`` worker handles one
    request at a time per process, so a single slow analysis blocks every other
    user behind it for its whole duration.

    ``gthread`` is the correct worker here, not an ASGI worker. Flask is a WSGI
    application: handing it to ``uvicorn.workers.UvicornWorker`` fails outright
    with "Flask.__call__() missing 1 required positional argument:
    'start_response'". Wrapping it in asgiref's WsgiToAsgi to make that work
    only re-serialises the app onto a thread again, so the ASGI worker buys
    nothing.

    flask[async] installs asgiref, which runs each ``async def`` view on an event
    loop scoped to the calling thread. A gthread worker with N threads therefore
    runs N analyses concurrently, each on its own loop, without the
    request-to-response overhead of a thread per request.

Timeout
    Gunicorn's default is 30 seconds. A full analysis runs OCR (up to 12
    Tesseract subprocesses, parallelised) plus several LLM round trips with a
    90 second per-client timeout, so a legitimate request can far exceed 30
    seconds. At 30s the worker is SIGKILLed mid-request: the user sees a dropped
    connection and the LLM spend is wasted.

    The worker timeout must stay comfortably above the application's own
    analysis budget, or gunicorn kills requests the app was still working on.

Graceful timeout
    After the hard timeout, gunicorn gives a worker this long to finish
    in-flight work before killing it, so an async view can unwind cleanly.

Worker and thread count
    Defaults to one worker per core, capped, with 4 threads each. Note that the
    per-token rate limiter and the analysis cache are in-process, so the
    effective global rate limit is workers * threads * RATE_LIMIT. Keep the
    product modest for that reason; see app/rate_limit.py.
"""

import multiprocessing
import os

# --------------------------------------------------------------------------
# Socket and application
# --------------------------------------------------------------------------
bind = os.getenv("GUNICORN_BIND", "0.0.0.0:8000")

# Without this, gunicorn exits with "No application module specified" before it
# ever starts a worker.
wsgi_app = "app.main:app"

# --------------------------------------------------------------------------
# Worker class and concurrency
# --------------------------------------------------------------------------

# gthread: one event loop per thread via asgiref, so N analyses run
# concurrently. See the module docstring for why an ASGI worker is not usable
# with a WSGI Flask app.
worker_class = "gthread"

_default_threads = min(16, (multiprocessing.cpu_count() or 1) * 2)
threads = int(os.getenv("GUNICORN_THREADS", str(_default_threads)))
workers = int(
    os.getenv("GUNICORN_WORKERS", str(min(multiprocessing.cpu_count() or 1, 4)))
)

# Reload in development, never in production.
reload = os.getenv("GUNICORN_RELOAD", "false").lower() in {"1", "true", "yes", "on"}

# Cap concurrent connections per worker so a burst is queued by gunicorn rather
# than piling up threads, which the rate limiter should be doing anyway.
worker_connections = int(os.getenv("GUNICORN_WORKER_CONNECTIONS", "1000"))

# --------------------------------------------------------------------------
# Timeouts
# --------------------------------------------------------------------------
# Hard ceiling on a single request. Must exceed the application's own analysis
# budget or gunicorn will kill requests the app was still working on.
timeout = int(os.getenv("ANALYSIS_TIMEOUT_SECONDS", "180"))

# How long a worker that hit the hard timeout gets to finish what it holds.
graceful_timeout = int(os.getenv("GRACEFUL_TIMEOUT_SECONDS", "30"))

# Keep-alive must stay below any upstream load-balancer idle timeout, or the
# balancer closes sockets the worker still considers live.
keepalive = int(os.getenv("GUNICORN_KEEPALIVE", "5"))

# Recycle workers periodically to bound any slow leak in a long-lived process.
max_requests = int(os.getenv("GUNICORN_MAX_REQUESTS", "1000"))
max_requests_jitter = int(os.getenv("GUNICORN_MAX_REQUESTS_JITTER", "100"))

# --------------------------------------------------------------------------
# Logging
# --------------------------------------------------------------------------
accesslog = os.getenv("GUNICORN_ACCESS_LOG", "-")
errorlog = os.getenv("GUNICORN_ERROR_LOG", "-")
loglevel = os.getenv("GUNICORN_LOG_LEVEL", "info")

# The application configures logging via app.logging_config, so gunicorn's own
# handler writes to stdout rather than duplicating it.
access_log_format = (
    '%({x-forwarded-for}i)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s" %(L)s'
)

# --------------------------------------------------------------------------
# Process naming
# --------------------------------------------------------------------------
proc_name = "ublockai-api"


def on_starting(server):
    server.log.info(
        "worker_class=%s workers=%d threads=%d timeout=%ss graceful=%ss; "
        "rate limits and the analysis cache are per-process, so the effective "
        "rate limit is workers x threads x RATE_LIMIT",
        worker_class,
        workers,
        threads,
        timeout,
        graceful_timeout,
    )
