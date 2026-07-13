FROM node:20-alpine

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

# Copy source code
COPY backend/ ./

EXPOSE 3001

CMD ["npm", "run", "dev"]
