#!/bin/sh
set -e

# Build shared/dist if it hasn't been built yet — Vite dev needs the
# compiled JS to resolve `@wanderline/shared` imports (the shared
# package.json points main at dist/index.js).
#
# Use the container's own tsc rather than `npm install` inside
# /shared: /shared is a host bind mount, so an install here would
# leave root-owned files on the host. The frontend image already
# has typescript installed under /app/node_modules.
if [ -d /shared ] && [ ! -d /shared/dist ]; then
  echo "Building shared..."
  /app/node_modules/.bin/tsc -p /shared/tsconfig.json
fi

# Symlink /shared into node_modules so npm's module resolver finds
# @wanderline/shared. See the same block in backend/start-dev.sh.
mkdir -p /app/node_modules/@wanderline
ln -sfn /shared /app/node_modules/@wanderline/shared

exec "$@"
