#!/bin/sh
set -e

# frontend/package.json declares "@wanderline/shared": "file:../shared",
# so the image's build-time `npm install` already resolved the dep
# and created the /app/node_modules/@wanderline/shared symlink. This
# entrypoint only handles the two things that install can't:
#   1. Build /shared/dist so Vite dev can resolve the shared
#      package's main entry (dist/index.js). Invoke tsc directly
#      against /shared/tsconfig.json — do NOT `npm install` inside
#      /shared, that's a host bind mount and would leave root-owned
#      files on the host.
#   2. Re-symlink /shared into /app/node_modules as a safety net.
#      Idempotent, and covers an image built before the file: switch.
# The backend container's start-dev.sh is the primary builder of
# /shared/dist. Wait for it to finish (up to 60s) rather than
# racing here — running tsc concurrently in both containers can
# interleave writes to /shared/dist, and gating on `[ ! -d dist ]`
# alone lets Vite start before the file emission is complete.
# The `.built` sentinel is `touch`ed AFTER tsc returns.
if [ -d /shared ] && [ ! -f /shared/dist/.built ]; then
  echo "Waiting for backend to build /shared/dist..."
  n=0
  while [ ! -f /shared/dist/.built ] && [ "$n" -lt 60 ]; do
    sleep 1
    n=$((n + 1))
  done
  if [ ! -f /shared/dist/.built ]; then
    echo "Timeout waiting for /shared/dist; building here."
    /app/node_modules/.bin/tsc -p /shared/tsconfig.json
    touch /shared/dist/.built
    # Match /shared's host ownership so `rm -rf shared/dist` on
    # the host works without sudo on Linux (see the same block in
    # backend/start-dev.sh for the rationale).
    chown -R "$(stat -c '%u:%g' /shared)" /shared/dist
  fi
fi

mkdir -p /app/node_modules/@wanderline
ln -sfn /shared /app/node_modules/@wanderline/shared

exec "$@"
