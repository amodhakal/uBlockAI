"""Local git hooks.

Installed with `python backend/scripts/install_hooks.py` or `make hooks`. The
hook runs the same lint, format, type and fast-test checks CI runs, so a problem
is caught before push rather than in a pull request.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND = REPO_ROOT / "backend"
EXTENSION = REPO_ROOT / "frontend" / "extension"

HOOK = """#!/bin/sh
# Managed by backend/scripts/install_hooks.py. Do not edit; re-run the installer.
set -e

repo_root=$(git rev-parse --show-toplevel)

if [ -x "$repo_root/backend/.venv/bin/ruff" ]; then
  echo "pre-commit: backend (ruff, mypy, pytest)"
  ( cd "$repo_root/backend" && .venv/bin/ruff check . && .venv/bin/ruff format --check . )
  ( cd "$repo_root/backend" && .venv/bin/mypy app )
  ( cd "$repo_root/backend" && .venv/bin/pytest -q )
fi

if [ -d "$repo_root/frontend/extension/node_modules" ]; then
  echo "pre-commit: extension (eslint, prettier)"
  ( cd "$repo_root/frontend/extension" && npm run --silent lint && npm run --silent format:check )
fi

echo "pre-commit: ok"
"""


def hook_path() -> Path:
    git_dir = subprocess.run(
        ["git", "rev-parse", "--git-dir"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    return REPO_ROOT / git_dir / "hooks" / "pre-commit"


def install() -> int:
    path = hook_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    if (
        path.exists()
        and "Managed by backend/scripts/install_hooks.py" not in path.read_text()
    ):
        print(f"refusing to overwrite existing hook at {path}", file=sys.stderr)
        print("move it aside and re-run if you want the managed hook", file=sys.stderr)
        return 1

    path.write_text(HOOK)
    os.chmod(path, 0o755)
    print(f"installed pre-commit hook at {path}")
    print("run `make check` for the same checks without committing")
    return 0


if __name__ == "__main__":
    raise SystemExit(install())
