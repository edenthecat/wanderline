FROM node:20-alpine

WORKDIR /app

# Copy frontend package metadata only — the dev container installs
# in isolation (no workspace context) so host & container don't fight
# over symlinked workspace deps via the mounted volume.
#
# WARNING for devs: do NOT `npm install` *inside* this container with
# the host volume mounted — it would emit a per-workspace
# frontend/package-lock.json into the host repo, creating a second
# source of truth alongside the root workspace lockfile. Run installs
# from the host so root lockfile stays canonical.
COPY frontend/package.json ./

RUN npm install

# Copy source code
COPY frontend/ ./
COPY shared/ ../shared/

EXPOSE 3000

CMD ["npm", "run", "dev"]
