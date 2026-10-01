# Build context is the repository root. No credentials or project files belong in this image.
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
COPY platform ./platform
RUN npm ci --ignore-scripts && npm run build:server

FROM node:24.21.0-bookworm-slim AS dependencies
WORKDIR /opt/runtime
COPY package.json package-lock.json ./
COPY platform/apps/web/package.json ./platform/apps/web/package.json
COPY platform/packages ./platform/packages
RUN npm ci --ignore-scripts --omit=dev --workspace @wovenmatter-enterprise/runtime --include-workspace-root=false

FROM node:24.21.0-bookworm-slim AS toolkit
WORKDIR /opt/toolkit
COPY platform/runtime/toolkit/package.json platform/runtime/toolkit/package-lock.json ./
RUN npm ci --ignore-scripts
COPY platform/runtime/toolkit/build.mjs ./build.mjs

FROM node:24.21.0-bookworm-slim
ARG GROK_VERSION=1.0.41
ARG GROK_SHA256=9ce03ed23e16ea01072b4496263d6213a27899e1e3e107f008d36edf82e70407
RUN test "$(dpkg --print-architecture)" = amd64 \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 python3-venv poppler-utils unzip ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://x.ai/cli/grok-${GROK_VERSION}-linux-x86_64" -o /usr/local/bin/grok \
 && echo "${GROK_SHA256}  /usr/local/bin/grok" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/grok \
 && npm install --global --ignore-scripts @openai/codex@0.158.0 \
 && groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid 10001 --home-dir /home/agent --shell /bin/bash agent \
 && mkdir -p /workspace /session /home/agent \
 && chown 10001:10001 /workspace /session /home/agent
WORKDIR /opt/runtime
COPY platform/runtime/document-requirements.txt /opt/document-requirements.txt
RUN python3 -m venv /opt/document-tools \
 && /opt/document-tools/bin/pip install --no-cache-dir --no-deps -r /opt/document-requirements.txt
COPY --from=dependencies /opt/runtime/node_modules ./node_modules
COPY --from=build /build/platform/dist/packages/runtime/src ./src
COPY --from=toolkit /opt/toolkit /opt/toolkit
COPY platform/runtime/AGENTS.md /opt/runtime/AGENTS.md
RUN ln -s /opt/toolkit/build.mjs /usr/local/bin/wme-build && chmod 0755 /opt/toolkit/build.mjs
ENV NODE_ENV=production HOME=/home/agent PATH=/opt/document-tools/bin:/opt/toolkit/node_modules/.bin:/usr/local/bin:/usr/bin:/bin
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/wovenmatter-enterprise/
COPY third-party /usr/share/doc/wovenmatter-enterprise/third-party
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/runtime/src/entrypoint.js"]
