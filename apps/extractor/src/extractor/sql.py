"""Loader for the worker's SQL statements.

The files in `extractor/statements/` are the single copy: Python executes them and
`packages/db/test/worker-sql.test.ts` PREPAREs them against a migrated Postgres. See
`statements/README.md` for why they are files rather than string literals in this module.

They live *inside* the package, not beside it, so the path resolves identically from a
source checkout and from the wheel installed on Fly.io. A loader that worked in tests and
raised on the machine would defeat the point of the exercise.
"""

from __future__ import annotations

from functools import cache
from pathlib import Path

SQL_DIR = Path(__file__).resolve().parent / "statements"


@cache
def _load() -> dict[str, str]:
    if not SQL_DIR.is_dir():
        raise FileNotFoundError(f"worker SQL directory missing: {SQL_DIR}")
    return {
        path.stem: path.read_text(encoding="utf-8").strip()
        for path in sorted(SQL_DIR.glob("*.sql"))
    }


def statement(name: str) -> str:
    statements = _load()
    if name not in statements:
        raise KeyError(f"unknown statement {name!r}; have {sorted(statements)}")
    return statements[name]


def names() -> tuple[str, ...]:
    return tuple(_load())
