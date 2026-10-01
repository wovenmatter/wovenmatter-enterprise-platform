#!/usr/bin/env bash
set -euo pipefail

# Explicitly opt in on a Linux CI/acceptance host. Never starts Docker Desktop.
if [[ "${WME_RUN_CONTAINER_ACCEPTANCE:-}" != 1 || "$(uname -s)" != Linux ]]; then
  echo 'Set WME_RUN_CONTAINER_ACCEPTANCE=1 on a Linux Docker/AppArmor host.' >&2
  exit 2
fi
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root"
node --test platform/runtime/fixture-cleanup.test.mjs
image="${WME_AGENT_IMAGE:-wme-agent-runtime:acceptance}"
docker info >/dev/null
if [[ $(id -u) == 0 ]]; then
  apparmor_parser -r platform/runtime/wme-platform-agent.apparmor
else
  sudo apparmor_parser -r platform/runtime/wme-platform-agent.apparmor
fi
docker build --platform linux/amd64 -f platform/runtime/Dockerfile -t "$image" .
WME_AGENT_IMAGE="$image" node platform/runtime/container-acceptance.mjs
