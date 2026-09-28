"""Gunicorn configuration.

The config is a deployment artefact, but its two load-bearing values are easy to
break silently, so they are asserted here.
"""

import multiprocessing
import runpy
import os

import pytest

from app.tests.conftest import BACKEND_ROOT

CONFIG_PATH = os.path.join(BACKEND_ROOT, "gunicorn.conf.py")


@pytest.fixture(scope="module")
def conf():
    return runpy.run_path(CONFIG_PATH)


def test_config_names_the_wsgi_app(conf):
    # Without this, gunicorn exits with "No application module specified" before
    # it ever starts a worker.
    assert conf["wsgi_app"] == "app.main:app"


def test_worker_class_runs_async_flask_views_concurrently(conf):
    # gthread, not sync: the default sync worker handles one request at a time
    # per process, so a single slow analysis blocks every other request behind
    # it. An ASGI worker is not usable either, because Flask is WSGI and
    # UvicornWorker raises "Flask.__call__() missing start_response".
    assert conf["worker_class"] == "gthread"
    assert conf["threads"] >= 2, "a single thread cannot overlap requests"


def test_timeout_exceeds_a_legitimate_analysis(conf, monkeypatch):
    # The pipeline runs OCR plus several LLM round trips with a 90s per-client
    # timeout. Gunicorn's 30s default SIGKILLs those mid-request, wasting the
    # LLM spend and dropping the user's connection.
    assert conf["timeout"] >= 180
    assert conf["timeout"] > 90, "must exceed the per-client LLM timeout"


def test_graceful_timeout_leaves_room_to_unwind(conf):
    assert 0 < conf["graceful_timeout"] < conf["timeout"]


def test_keepalive_is_short_enough_for_a_load_balancer(conf):
    assert 0 < conf["keepalive"] <= 75


def test_workers_are_capped(conf):
    # Rate limits and the analysis cache are per-process, so an uncapped worker
    # count multiplies the effective rate limit without bound.
    assert 1 <= conf["workers"] <= 4
    assert conf["workers"] <= (multiprocessing.cpu_count() or 1)


def test_reload_is_off_by_default(conf):
    assert conf["reload"] is False


def test_workers_are_recycled(conf):
    # Bounds any slow leak in a long-lived worker process.
    assert conf["max_requests"] > 0
    assert conf["max_requests_jitter"] > 0
