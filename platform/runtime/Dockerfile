# Build context is the repository root. No credentials or project files belong in this image.
FROM node:26.12.1-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe AS boundary
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY platform/runtime/restrict.c /tmp/restrict.c
RUN gcc -O2 -Wall -Werror -o /wme-restrict /tmp/restrict.c

FROM node:26.12.1-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe AS build
WORKDIR /build
COPY package.json package-lock.json ./
COPY platform ./platform
RUN npm install --global npm@12.2.0 && npm ci --no-audit --no-fund --ignore-scripts && npm run build:server

FROM node:26.12.1-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe AS dependencies
WORKDIR /opt/runtime
COPY package.json package-lock.json ./
COPY platform/apps/web/package.json ./platform/apps/web/package.json
COPY platform/packages/runtime/package.json ./platform/packages/runtime/package.json
RUN npm install --global npm@12.2.0 && npm ci --no-audit --no-fund --ignore-scripts --omit=dev --workspace @wovenmatter-enterprise/runtime --include-workspace-root=false
COPY platform/runtime/install-native.mjs /opt/install-native.mjs
COPY platform/tools/prepare-pi-package.mjs /opt/prepare-pi-package.mjs
RUN node /opt/prepare-pi-package.mjs /opt/runtime/node_modules \
 && node /opt/install-native.mjs /opt/runtime/node_modules

FROM node:26.12.1-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe
RUN test "$(dpkg --print-architecture)" = amd64 \
 && apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 python3-venv poppler-utils unzip ripgrep bubblewrap apparmor-utils \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid 10001 --home-dir /home/agent --shell /bin/bash agent \
 && mkdir -p /workspace /session /home/agent \
 && chown 10001:10001 /workspace /session /home/agent
WORKDIR /opt/runtime
RUN npm install --global npm@12.2.0 && npm cache clean --force
COPY platform/runtime/document-requirements.txt /opt/document-requirements.txt
RUN python3 -m venv /opt/document-tools \
 && /opt/document-tools/bin/pip install --no-cache-dir --no-deps -r /opt/document-requirements.txt \
 && /opt/document-tools/bin/pip check
COPY --from=dependencies /opt/runtime/node_modules ./node_modules
# The coordinator, supervisor and runner identify the same bundled SDK generation.
COPY package-lock.json ./package-lock.json
COPY --from=build /build/platform/dist/packages/runtime/src ./src
RUN chmod 0755 /opt/runtime/src/background-cli.js && ln -s /opt/runtime/src/background-cli.js /usr/local/bin/wme-background
RUN chmod 0755 /opt/runtime/src/asset-cli.js && ln -s /opt/runtime/src/asset-cli.js /usr/local/bin/wme-asset
RUN chmod 0755 /opt/runtime/src/workspace-cli.js && ln -s /opt/runtime/src/workspace-cli.js /usr/local/bin/wme-workspace
# Native adapters and their pinned CLI dependencies are installed from the lockfile.
RUN test -x /opt/runtime/node_modules/.bin/codex-acp \
 && test -x /opt/runtime/node_modules/.bin/claude-agent-acp \
 && test -x /opt/runtime/node_modules/.bin/grok \
 && test -x /opt/runtime/node_modules/.bin/opencode
COPY platform/runtime/AGENTS.md /opt/runtime/AGENTS.md
ENV NODE_ENV=production HOME=/home/agent PATH=/opt/document-tools/bin:/usr/local/bin:/usr/bin:/bin
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/wovenmatter-enterprise/
COPY third-party /usr/share/doc/wovenmatter-enterprise/third-party
COPY --from=boundary /wme-restrict /usr/local/bin/wme-restrict
ARG WME_REVISION=development
LABEL org.opencontainers.image.revision=$WME_REVISION
ENV WME_REVISION=$WME_REVISION
USER 0:0
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/runtime/src/project-daemon.js"]
