#!/bin/sh
set -e

# The backend, player-app, and any tsx-compiled backend module can
# import @wanderline/shared. In the docker-compose dev flow every
# consumer's package.json declares "@wanderline/shared":
# "file:../shared" (see backend/package.json etc.), so npm resolves
# the dep to /shared at install time — no npm registry fetch, no
# root-owned files on the host bind mount. This script only handles
# two things npm install can't:
#   1. Build shared/dist so runtime imports of `@wanderline/shared`
#      resolve to compiled JS. Invoke tsc directly against
#      /shared/tsconfig.json — do NOT `npm install` inside /shared,
#      that's a host bind mount and would leave root-owned
#      shared/node_modules on the host.
#   2. Symlink /shared into /app/node_modules as a safety net.
#      The backend Dockerfile already creates this symlink at
#      build time (via file:../shared in package.json), and the
#      anonymous volume `- /app/node_modules` in docker-compose.yml
#      preserves it, but re-linking here is idempotent and covers
#      an image built before the file: switch.
# Gate on a sentinel file (`dist/.built`) written AFTER tsc
# returns, not on the existence of the dist directory. tsc creates
# the directory before it finishes emitting files, so an
# `[ ! -d dist ]` guard has a race where the frontend container
# sees dist/ present, skips its own build, and starts Vite before
# our tsc has written dist/index.js.
if [ -d /shared ] && [ ! -f /shared/dist/.built ]; then
  echo "Building shared..."
  /app/node_modules/.bin/tsc -p /shared/tsconfig.json
  touch /shared/dist/.built
  # Chown to match /shared's host ownership. Alpine's `stat -c` on
  # the bind-mount root reports the host UID/GID, and we run as
  # root here, so this hands ownership of the emitted dist/ back to
  # the host user. Without it, Linux hosts end up with root-owned
  # shared/dist/ files that need `sudo rm -rf` to clean up (macOS
  # Docker Desktop transparently remaps UIDs so it's a no-op there).
  chown -R "$(stat -c '%u:%g' /shared)" /shared/dist
fi

link_shared_into() {
  target="$1"
  if [ -d "$target" ]; then
    mkdir -p "$target/node_modules/@wanderline"
    ln -sfn /shared "$target/node_modules/@wanderline/shared"
  fi
}
link_shared_into /app

# Build player-app if dist doesn't exist (for preview serving).
# Symlink shared BEFORE npm install so that if any tool inspects
# node_modules mid-install (or if the install somehow fails), the
# shared package is already resolvable. Re-link after too, since
# some npm code paths recreate node_modules subdirectories.
if [ -d /player-app ] && [ ! -d /player-app/dist ]; then
  echo "Building player-app..."
  link_shared_into /player-app
  cd /player-app && npm install --silent --no-package-lock
  link_shared_into /player-app
  npm run build
  echo "Player-app built successfully"
  cd /app
fi

# Start the backend
exec npm run dev
