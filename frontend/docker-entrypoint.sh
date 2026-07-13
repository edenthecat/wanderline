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
if [ -d /shared ] && [ ! -d /shared/dist ]; then
  echo "Building shared..."
  /app/node_modules/.bin/tsc -p /shared/tsconfig.json
fi

mkdir -p /app/node_modules/@wanderline
ln -sfn /shared /app/node_modules/@wanderline/shared

exec "$@"
