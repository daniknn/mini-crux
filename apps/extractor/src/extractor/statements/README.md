# Worker SQL

Every statement the Python worker issues lives here as a `.sql` file rather than as a
string literal in Python.

## Why

The Python test suite has no Postgres. PGlite is a JavaScript package, so the real-database
harness that covers the rest of this repo (`packages/db`) cannot be imported from Python,
and adding a Docker service to the extractor CI job to test eight statements is a poor
trade — it would make the fastest job in CI the slowest and the only one needing a daemon.

That leaves a gap with a specific shape: a mistyped column name in a worker `INSERT` is
invisible until it runs in production, against data that cannot be re-crawled.

Keeping the statements as files closes it. `packages/db/test/worker-sql.test.ts` reads this
directory and `PREPARE`s every statement against a freshly-migrated PGlite database.
`PREPARE` parses and plans without executing, so every table name, column name and
parameter cast is validated against the real schema — no fixtures, no cleanup, and it fails
the moment a migration renames something the worker still refers to.

Python loads the same files at import time (`extractor.sql`), so the artifact under test
is the artifact that runs.

## Conventions

- One statement per file. `PREPARE` accepts exactly one.
- Parameters are `$1`, `$2`, … and **must carry an explicit cast**. Postgres cannot infer a
  type for a bare parameter in every position, and an un-inferable one fails to prepare.
- No trailing semicolon.
