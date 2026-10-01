# Build from repository root: docker build --target application -t wme-platform:COMMIT .
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY platform/apps/api/package.json platform/apps/api/package.json
COPY platform/apps/web/package.json platform/apps/web/package.json
COPY platform/packages/runtime/package.json platform/packages/runtime/package.json
RUN npm ci --ignore-scripts
COPY platform ./platform
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24.21.0-bookworm-slim AS application-base
ENV NODE_ENV=production WME_HOST=0.0.0.0 WME_PORT=4100
WORKDIR /app
RUN groupadd --gid 10001 wovenmatter-enterprise && useradd --uid 10001 --gid 10001 --no-create-home wovenmatter-enterprise
COPY --from=build --chown=10001:10001 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/platform ./platform
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/wovenmatter-enterprise/
COPY third-party /usr/share/doc/wovenmatter-enterprise/third-party
USER 10001:10001
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s CMD node -e "const q=require('http').get({hostname:'127.0.0.1',port:4100,path:'/healthz',headers:{host:new URL(process.env.WME_PUBLIC_ORIGIN||'http://localhost:4100').host}},r=>{r.resume();process.exit(r.statusCode===200?0:1)});q.on('error',()=>process.exit(1))"
CMD ["node", "platform/dist/apps/api/src/main.js"]

# Trusted supervisor alone receives Docker authority. Never use this target for the API.
FROM docker:29.8.0-cli AS docker-cli
FROM application-base AS supervisor
USER root
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
HEALTHCHECK NONE
CMD ["node", "platform/dist/deploy/supervisor.js"]

# Safe default target: ordinary docker build never produces the privileged supervisor.
FROM application-base AS application
