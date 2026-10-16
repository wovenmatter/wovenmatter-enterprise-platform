# Build context is the repository root. No credentials or project files belong in this image.
FROM node:24.21.0-bookworm-slim AS boundary
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY platform/runtime/restrict.c /tmp/restrict.c
RUN gcc -O2 -Wall -Werror -o /wme-restrict /tmp/restrict.c

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

FROM node:24.21.0-bookworm-slim
RUN test "$(dpkg --print-architecture)" = amd64 \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 python3-venv poppler-utils unzip ripgrep bubblewrap apparmor-utils \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid 10001 --home-dir /home/agent --shell /bin/bash agent \
 && mkdir -p /workspace /session /home/agent \
 && chown 10001:10001 /workspace /session /home/agent
WORKDIR /opt/runtime
COPY platform/runtime/document-requirements.txt /opt/document-requirements.txt
RUN python3 -m venv /opt/document-tools \
 && /opt/document-tools/bin/pip install --no-cache-dir --no-deps -r /opt/document-requirements.txt
COPY --from=dependencies /opt/runtime/node_modules ./node_modules
# The coordinator, supervisor and runner identify the same bundled SDK generation.
COPY package-lock.json ./package-lock.json
COPY --from=build /build/platform/dist/packages/runtime/src ./src
RUN chmod 0755 /opt/runtime/src/background-cli.js && ln -s /opt/runtime/src/background-cli.js /usr/local/bin/wme-background
RUN chmod 0755 /opt/runtime/src/asset-cli.js && ln -s /opt/runtime/src/asset-cli.js /usr/local/bin/wme-asset
COPY platform/runtime/AGENTS.md /opt/runtime/AGENTS.md
ENV NODE_ENV=production HOME=/home/agent PATH=/opt/document-tools/bin:/usr/local/bin:/usr/bin:/bin
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/wovenmatter-enterprise/
COPY third-party /usr/share/doc/wovenmatter-enterprise/third-party
COPY --from=boundary /wme-restrict /usr/local/bin/wme-restrict
USER 0:0
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/runtime/src/project-daemon.js"]
