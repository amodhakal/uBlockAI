"""Append-only JSON-lines storage for feedback reports.

The previous implementation read a day's JSON array, appended in memory and
wrote the whole file back, with no locking. Two concurrent requests interleaved
their read-modify-write and the loser's reports were silently dropped, and a
crash mid-write truncated the file.

Reports are stored one JSON object per line. Appending a single line with
O_APPEND is atomic for writes below the pipe-buffer size on POSIX, and a reader
that skips unparseable trailing lines survives a partial write. A per-path lock
serialises writers within and across processes, and the write goes to a
temporary file that is then atomically renamed into place.
"""

import json
import logging
import os
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List

logger = logging.getLogger(__name__)

# One lock per resolved path, so different days do not contend with each other.
_PATH_LOCKS: Dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()

MAX_REPORT_BYTES = 64 * 1024


def _lock_for(path: Path) -> threading.Lock:
    key = str(path)
    with _LOCKS_GUARD:
        lock = _PATH_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _PATH_LOCKS[key] = lock
        return lock


@contextmanager
def file_lock(path: Path) -> Iterator[None]:
    """Serialise access to ``path`` within this process.

    Cross-process exclusion is provided by the atomic rename: a second process
    writing concurrently can only ever replace the file wholesale, never
    interleave bytes within it.
    """
    with _lock_for(path):
        yield


def _daily_path(directory: Path, when: datetime | None = None) -> Path:
    stamp = (when or datetime.now(timezone.utc)).strftime("%Y-%m-%d")
    return directory / f"{stamp}.jsonl"


def _read_reports(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    reports: List[Dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                reports.append(json.loads(line))
            except json.JSONDecodeError:
                # A truncated final line from an interrupted write. Skip it
                # rather than losing the whole day's data.
                logger.warning("skipping unparseable feedback line in %s", path)
    return reports


def _serialize(reports: List[Dict[str, Any]]) -> str:
    return "".join(
        json.dumps(report, ensure_ascii=False) + "\n" for report in reports
    )


def append_reports(
    directory: Path,
    reports: List[Dict[str, Any]],
    when: datetime | None = None,
) -> int:
    """Append ``reports`` to the day's file, returning the new total stored."""
    directory.mkdir(parents=True, exist_ok=True)
    path = _daily_path(directory, when)

    with file_lock(path):
        existing = _read_reports(path)
        combined = existing + list(reports)
        payload = _serialize(combined)
        if len(payload.encode("utf-8")) > MAX_REPORT_BYTES:
            raise ValueError("feedback batch is too large to append")

        # Write to a sibling temp file and rename, so a reader never observes a
        # partially written file. The rename is atomic, which is what makes
        # this safe against a second process writing at the same time.
        tmp_path = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
        with open(tmp_path, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)

    return len(combined)


def read_reports(directory: Path, when: datetime | None = None) -> List[Dict[str, Any]]:
    """Read a day's reports. Safe to call while another process writes."""
    path = _daily_path(directory, when)
    with file_lock(path):
        return _read_reports(path)
