# The Python extractor: structural features from creative media.
#
# Built from this directory (unlike the TS worker, which needs the repo root):
#
#   docker build -f apps/extractor/Dockerfile apps/extractor
#
# `apps/extractor` is a self-contained uv project with its own lockfile and no workspace
# siblings — CLAUDE.md keeps Python's ownership to exactly this directory — so the build
# context is the directory itself.

FROM python:3.12-slim-bookworm AS base

# uv from its own published image rather than `pip install uv`: it pins the version by
# digest and skips a bootstrap pip resolve, which is the slowest step in an otherwise fast
# build.
COPY --from=ghcr.io/astral-sh/uv:0.9.7 /uv /uvx /usr/local/bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# ffmpeg is not optional: faster-whisper and librosa both decode audio through it, and
# without it the backends raise at *runtime* on the first video — which `BackendUnavailable`
# would then record as "skipped", turning a missing system package into a silently degraded
# feature set rather than a failed build.
#
# libgl1 and libglib2.0-0 are opencv's. `opencv-python-headless` drops the GUI dependencies
# but still links these two.
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        ffmpeg \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── dependencies ─────────────────────────────────────────────────────────────
# Lockfile and manifest first so a source edit does not re-resolve — which here means not
# re-downloading torch, roughly 2GB of the image.
FROM base AS deps

COPY pyproject.toml uv.lock ./

# `--extra ml` on purpose. CI installs core + dev only, because model output is not
# deterministic across versions and must not gate a PR — but easyocr, faster-whisper and
# librosa are what actually runs in production. An image built the way CI installs would
# start fine, degrade every model-derived feature to `skipped`, and record that as a normal
# result. The spec (UC-2) states the split; this is the end of it where the models are real.
#
# `--no-install-project` installs only the dependency set, so the layer survives every
# change to our own source.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --extra ml --no-dev --no-install-project

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime

COPY --from=deps /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH" \
    VIRTUAL_ENV=/app/.venv

COPY pyproject.toml uv.lock ./
COPY src src

# Install the project itself into the venv that already holds its dependencies.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --extra ml --no-dev

# Model weights are downloaded on first use and cached here. Pointed at a writable path
# under the app rather than at root's home, because the process below is not root — and a
# cache the process cannot write means every restart re-downloads the model over the
# network before it can extract anything.
ENV HOME=/app \
    XDG_CACHE_HOME=/app/.cache \
    EASYOCR_MODULE_PATH=/app/.cache/easyocr

RUN useradd --create-home --home-dir /home/extractor --shell /usr/sbin/nologin extractor \
    && mkdir -p /app/.cache \
    && chown -R extractor:extractor /app
USER extractor

# Same shape as the TS worker and for the same reason: no port, no HTTP surface. What this
# process is *for* is observable in `creative_features`, not in a TCP handshake.
CMD ["python", "-m", "extractor.run", "--serve"]
