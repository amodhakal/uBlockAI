# One-command local development setup for uBlockAI.
#
#   python3 scripts/dev_setup.py
#
# Creates the backend virtualenv, installs runtime and development
# dependencies, installs the extension lint tooling, installs the git
# pre-commit hook, and verifies Tesseract is available. Safe to re-run.

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND = REPO_ROOT / "backend"
EXTENSION = REPO_ROOT / "frontend" / "extension"
VENV = BACKEND / ".venv"
BIN = "Scripts" if os.name == "nt" else "bin"


def run(cmd, cwd=None, check=True, quiet=False):
    printable = " ".join(str(c) for c in cmd)
    if not quiet:
        print(f"  $ {printable}")
    result = subprocess.run(
        [str(c) for c in cmd],
        cwd=str(cwd) if cwd else None,
        capture_output=quiet,
        text=True,
    )
    if check and result.returncode != 0:
        if quiet:
            print(result.stdout or "")
            print(result.stderr or "", file=sys.stderr)
        raise SystemExit(f"command failed: {printable}")
    return result


def step(number, total, title):
    print(f"\n[{number}/{total}] {title}")


def main() -> int:
    total = 6
    print("uBlockAI development setup")
    print(f"repository: {REPO_ROOT}")

    step(1, total, "Creating the backend virtualenv")
    if not (VENV / BIN / "python").exists():
        run([sys.executable, "-m", "venv", VENV])
    else:
        print("  already exists, reusing")
    python = VENV / BIN / "python"

    step(2, total, "Installing backend dependencies")
    run([python, "-m", "pip", "install", "--upgrade", "pip"], quiet=True)
    run([python, "-m", "pip", "install", "-r", BACKEND / "requirements.txt"], quiet=True)

    step(3, total, "Installing development and CI tooling")
    run([python, "-m", "pip", "install", "-r", BACKEND / "requirements-dev.txt"], quiet=True)

    step(4, total, "Checking for Tesseract")
    if shutil.which("tesseract"):
        version = run(["tesseract", "--version"], quiet=True).stdout.splitlines()[0]
        print(f"  found: {version}")
    else:
        system = platform.system()
        if system == "Darwin":
            print("  NOT FOUND. Install with: brew install tesseract")
        elif system == "Linux":
            print("  NOT FOUND. Install with: sudo apt-get install tesseract-ocr")
        else:
            print("  NOT FOUND. Install the Tesseract OCR binary and ensure it is on PATH.")
        print("  OCR will fail at request time until this is installed.")

    step(5, total, "Installing extension lint tooling")
    if (EXTENSION / "package.json").exists() and shutil.which("npm"):
        run(["npm", "install"], cwd=EXTENSION, quiet=True)
    else:
        print("  skipped (npm or package.json unavailable)")

    step(6, total, "Installing the git pre-commit hook")
    run([python, BACKEND / "scripts" / "install_hooks.py"], quiet=True)

    env_file = BACKEND / "app" / ".env"
    if not env_file.exists():
        print("\nOne thing left: create backend/app/.env with your API key:")
        print("  OPENAI_API_KEY=sk-...")
        print("  OPENAI_MODEL=gpt-4o")
        print("  BRAVE_API_KEY=...        # optional, enables the primary search provider")

    print("\nSetup complete. Next:")
    print("  make dev      start the backend on :8000")
    print("  make check    run lint, format, types and tests")
    print("  make test     run the test suite only")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
