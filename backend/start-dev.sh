#!/bin/sh
set -e

# Build player-app if dist doesn't exist (for preview serving)
if [ -d /player-app ] && [ ! -d /player-app/dist ]; then
  echo "Building player-app..."
  cd /player-app && npm install --silent --no-package-lock && npm run build
  echo "Player-app built successfully"
  cd /app
fi

# Start the backend
exec npm run dev
