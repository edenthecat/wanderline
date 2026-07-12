#!/bin/sh
set -e

# The backend, player-app, and any tsx-compiled backend module can
# import @wanderline/shared. In the docker-compose dev flow the
# workspace isn't wired up (each container ran `npm install` from a
# single workspace's package.json, no root-level install), so we
# have to make the shared package resolvable by hand:
#   1. Build shared/dist so consumers can import the compiled JS.
#   2. Symlink /shared into each consumer's node_modules under
#      @wanderline/ so npm's module resolver finds it.
if [ -d /shared ] && [ ! -d /shared/dist ]; then
  echo "Building shared..."
  cd /shared && npm install --silent --no-package-lock && npm run build
  cd /app
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
# Symlink shared AFTER npm install so the install doesn't wipe the
# node_modules dir we just prepared.
if [ -d /player-app ] && [ ! -d /player-app/dist ]; then
  echo "Building player-app..."
  cd /player-app && npm install --silent --no-package-lock
  link_shared_into /player-app
  npm run build
  echo "Player-app built successfully"
  cd /app
fi

# Start the backend
exec npm run dev
