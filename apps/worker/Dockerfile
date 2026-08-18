# The TypeScript worker: crawl → parse → analysis.
#
# Built from the repo root, not from this directory:
#
#   docker build -f apps/worker/Dockerfile .
#
# A pnpm workspace cannot be built from a leaf, because the lockfile and the workspace
# manifest live at the root and the worker's dependencies are sibling packages. Fly's
# `fly.toml` points at this file with `dockerfile = "apps/worker/Dockerfile"` and its own
# build context set to the root for the same reason.
#
# THERE IS NO BUILD STEP
#
# Node 24 strips types natively, so the worker runs its `.ts` entrypoints directly — the
# same files the tests import, with no emit in between. That removes the whole class of
# "works in dev, the compiled bundle disagrees" problems, and it is why `engines.node` in
# the root manifest is `>=24`: on 22 this needs a flag and warns on every start.

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# Corepack ships with Node and pins pnpm to `packageManager` in the root manifest, so the
# image and CI resolve the identical pnpm — a lockfile is only a guarantee if the tool
# reading it is the same one that wrote it.
RUN corepack enable

# ── dependencies ─────────────────────────────────────────────────────────────
# Manifests first, source second. Layer caching then means an edit to a handler does not
# re-resolve the dependency graph, which is the difference between a 20-second rebuild and
# a three-minute one during an incident.
FROM base AS deps
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json      packages/core/
COPY packages/db/package.json        packages/db/
COPY packages/analysis/package.json  packages/analysis/
COPY packages/ingestion/package.json packages/ingestion/
COPY apps/worker/package.json        apps/worker/

# `--prod` drops vitest and PGlite; the trailing `...` on the filter selects the worker
# *and its workspace dependencies*, which is what keeps Next.js, React and Clerk — the web
# app's tree, and by far the largest part of the lockfile — out of a worker image.
#
# `--frozen-lockfile` is the actual gate: without it a resolution drift between CI and the
# image would ship a dependency set nothing ever tested.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter '@mini-crux/worker...'

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /app

ENV NODE_ENV=production

# The whole deps stage, not a list of `node_modules` paths one per package. That list was
# wrong: `@mini-crux/analysis` declares only devDependencies, so under `--prod` pnpm creates
# no `node_modules` for it at all and the COPY failed the build with "not found". Any package
# whose entire dependency set is dev-only lands in the same hole, so the enumeration is a
# standing trap rather than a one-time mistake. The deps stage holds nothing but manifests,
# the lockfile and the installed trees — copying it whole is exact and cannot go stale.
COPY --from=deps /app ./

COPY packages/core      packages/core
COPY packages/db        packages/db
COPY packages/analysis  packages/analysis
COPY packages/ingestion packages/ingestion
COPY apps/worker        apps/worker

# Not optional. `MIGRATIONS_DIR` resolves `supabase/migrations` relative to `packages/db`,
# and the release command below reads it — an image without this directory deploys
# successfully and then applies nothing, which is the failure that looks like a working
# deploy right up until the first query against a missing column.
COPY supabase/migrations supabase/migrations

# Drop root. The worker makes outbound connections and writes nothing to disk, so it has no
# reason to hold privileges an exploit could use.
USER node

# No `EXPOSE` and no healthcheck port: this process has no HTTP surface by design. Liveness
# is visible in the `jobs` table and through `/api/health/ingestion`, which reports whether
# work is actually being *done* — a worker that is up but claiming nothing is exactly the
# failure a port check would call healthy.
CMD ["node", "apps/worker/src/main.ts"]
