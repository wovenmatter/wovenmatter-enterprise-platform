#!/usr/bin/env bash
set -euo pipefail
if [[ "${WME_RUN_CONTAINER_ACCEPTANCE:-}" != 1 || "$(uname -s)" != Linux ]]; then
  echo 'Set WME_RUN_CONTAINER_ACCEPTANCE=1 on an isolated Linux Docker/AppArmor runner.' >&2
  exit 2
fi
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root"
docker info >/dev/null
profiles=$(sudo cat /sys/kernel/security/apparmor/profiles)
for profile in wme-platform-agent wme-project-supervisor; do
  if ! grep -Fxq "$profile (enforce)" <<< "$profiles"; then
    if [[ "${WME_INSTALL_TEST_PROFILES:-}" != 1 ]]; then
      echo "Required profile $profile is absent; operator policy setup is required." >&2
      exit 2
    fi
    # Fresh disposable CI runner only. Never replace a host's existing profile.
    if grep -Eq "^${profile} " <<< "$profiles"; then
      echo "Existing profile $profile is not enforcing; refusing to replace it." >&2
      exit 2
    fi
    sudo apparmor_parser --skip-kernel-load --skip-cache "platform/runtime/$profile.apparmor"
    sudo apparmor_parser --add --skip-cache "platform/runtime/$profile.apparmor"
  fi
done
npm run build:server
node --test platform/runtime/*.test.mjs
image="${WME_AGENT_IMAGE:-wme-pr2-acceptance:ci-$(date +%s)-$$}"
docker build --platform linux/amd64 -f platform/runtime/Dockerfile -t "$image" .
if [[ "$EUID" == 0 ]]; then
  WME_AGENT_IMAGE="$image" node platform/runtime/container-acceptance.mjs
else
  # The disposable fixture must reproduce service-UID ownership. This is only
  # for the explicitly authorized isolated runner, never an implicit fallback.
  sudo -n env PATH="$PATH" WME_RUN_CONTAINER_ACCEPTANCE=1 \
    WME_AGENT_IMAGE="$image" \
    WME_ACCEPTANCE_ROOT="${WME_ACCEPTANCE_ROOT:-/tmp/wme-container-evidence}" \
    "$(command -v node)" platform/runtime/container-acceptance.mjs
fi
