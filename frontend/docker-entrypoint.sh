#!/bin/sh
set -e

# Build shared/dist if it hasn't been built yet — Vite dev needs the
# compiled JS to resolve `@wanderline/shared` imports (the shared
# package.json points main at dist/index.js).
if [ -d /shared ] && [ ! -d /shared/dist ]; then
  echo "Building shared..."
  cd /shared && npm install --silent --no-package-lock && npm run build
  cd /app
fi

# Symlink /shared into node_modules so npm's module resolver finds
# @wanderline/shared. See the same block in backend/start-dev.sh.
mkdir -p /app/node_modules/@wanderline
ln -sfn /shared /app/node_modules/@wanderline/shared

exec "$@"
