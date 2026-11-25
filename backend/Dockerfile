FROM node:22-alpine

# ffmpeg is used at runtime to transcode uploaded WAV audio to MP3.
# make/g++/python3 are kept for native npm modules (bcrypt in
# particular) that fall back to compiling from source when a prebuilt
# binary for the host arch isn't available on npm.
RUN apk add --no-cache ffmpeg make g++ python3

WORKDIR /app

# Copy shared/ BEFORE running npm install. backend/package.json
# declares "@wanderline/shared": "file:../shared", and this dev
# image installs in isolation (no npm workspaces context), so the
# file: path has to resolve locally at install time. From WORKDIR
# /app, "../shared" = /shared. The runtime bind mount replaces
# /shared with the host copy, so the resolved symlink under
# node_modules keeps working.
COPY shared/ /shared/
COPY backend/package*.json ./

# Install dependencies
RUN npm install

# Upgrade npm AFTER this image's own install above, not before.
#
# Why upgrade at all: start-dev.sh runs a second, isolated install at
# container startup (`cd /player-app && npm install
# --no-package-lock`) using this image's npm, and on Node 22 the
# bundled 10.9.9 crashes resolving that lockfile-less tree with
# `Cannot read properties of null (reading 'edgesOut')`. It passes
# --silent, so the container just stops logging after "Building
# player-app..." and never becomes healthy.
#
# Why after: npm 12 disables dependency install scripts by default,
# and backend depends on bcrypt, whose fallback to compiling from
# source is an install script. Installing above on the bundled npm
# leaves bcrypt's behavior unchanged and confines npm 12 to the
# player-app install that actually needs it, so no `allowScripts`
# policy is required (found in review).
RUN npm install -g npm@12.2.3

# Copy source code
COPY backend/ ./

EXPOSE 3001

CMD ["npm", "run", "dev"]
