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

# Make @wanderline/shared resolvable inside the container. Same
# rationale as backend/start-dev.sh: this container installs from
# frontend/package.json alone, no workspace context, so npm doesn't
# know about the shared package unless we symlink it into place.
# The bind mount at runtime replaces /shared with the host copy —
# the symlink target still resolves so the dev flow keeps working.
COPY frontend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm", "run", "dev"]
