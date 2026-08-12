# PRINTHEAD — .devcontainer/Dockerfile
# Everything builds and tests in here (spec §9): web app, full test suite,
# balance tooling, and the M7 STL pipeline. Only Apple signing lives on the host.
# User setup happens via the common-utils feature (remoteUser "claude").

FROM node:22-bookworm

# --- System deps -------------------------------------------------------------
# Base tooling + M7 STL pipeline (openscad = code-CAD, prusa-slicer = CI slice
# check, admesh = manifold audit). Baked into the image (not postCreate) so
# layers cache and CI uses the identical environment.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates jq ripgrep \
    openscad prusa-slicer admesh \
    && rm -rf /var/lib/apt/lists/*

# --- Playwright system libraries (browsers install per-project, postCreate) --
RUN npx -y playwright install-deps chromium

# --- pnpm via corepack -------------------------------------------------------
RUN corepack enable && corepack prepare pnpm@latest --activate