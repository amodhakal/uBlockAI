# uBlockAI developer tasks.
#
#   make setup   install everything (backend venv, node modules, git hooks)
#   make dev     run the backend with reload
#   make check   run every gate CI runs
#   make test    run the test suite
#   make hooks   install the git pre-commit hook

BACKEND := backend
EXTENSION := frontend/extension
VENV := $(BACKEND)/.venv
PY := $(VENV)/bin/python

.DEFAULT_GOAL := help
.PHONY: help setup setup-backend setup-extension dev check lint format type test audit hooks clean

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

setup: setup-backend setup-extension hooks ## Install all dependencies and git hooks

setup-backend: ## Create the venv and install backend + dev dependencies
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install --upgrade pip
	$(VENV)/bin/pip install -r $(BACKEND)/requirements-dev.txt
	@echo "Tesseract is required for OCR:"
	@echo "  macOS:   brew install tesseract"
	@echo "  Debian:  sudo apt-get install tesseract-ocr"

setup-extension: ## Install extension lint tooling
	cd $(EXTENSION) && npm install

dev: ## Run the backend with autoreload
	cd $(BACKEND) && .venv/bin/python -m flask --app app.main run --host 0.0.0.0 --port 8000 --debug

check: lint format type test ## Run every CI gate

lint: ## Ruff lint
	cd $(BACKEND) && .venv/bin/ruff check .
	cd $(EXTENSION) && npm run --silent lint

format: ## Verify formatting
	cd $(BACKEND) && .venv/bin/ruff format --check .
	cd $(EXTENSION) && npm run --silent format:check

type: ## Mypy
	cd $(BACKEND) && .venv/bin/mypy app

test: ## Pytest
	cd $(BACKEND) && .venv/bin/pytest

audit: ## Audit dependencies for known vulnerabilities
	cd $(BACKEND) && .venv/bin/pip install -q pip-audit && .venv/bin/pip-audit --requirement requirements.txt --strict

hooks: ## Install the git pre-commit hook
	$(PY) $(BACKEND)/scripts/install_hooks.py

clean: ## Remove caches and build artifacts
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
	rm -rf $(BACKEND)/.pytest_cache $(BACKEND)/.ruff_cache $(BACKEND)/.mypy_cache
	rm -rf $(EXTENSION)/node_modules
