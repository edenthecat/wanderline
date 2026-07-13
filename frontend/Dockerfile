FROM node:20-alpine

WORKDIR /app

# Copy shared/ BEFORE running npm install. frontend/package.json
# declares "@wanderline/shared": "file:../shared", and this dev
# image installs in isolation (no npm workspaces context), so the
# file: path has to resolve locally at install time. From WORKDIR
# /app, "../shared" = /shared. The runtime bind mount replaces
# /shared with the host copy, so the resolved symlink under
# node_modules keeps working.
#
# WARNING for devs: do NOT `npm install` *inside* this container
# with the host volume mounted — it would emit a per-workspace
# frontend/package-lock.json into the host repo, creating a second
# source of truth alongside the root workspace lockfile. Run
# installs from the host so root lockfile stays canonical.
COPY shared/ /shared/
COPY frontend/package.json ./

RUN npm install

# Copy source code
COPY frontend/ ./

# Entrypoint builds shared/dist (once, if missing) so runtime
# imports of `@wanderline/shared` can resolve to its compiled JS.
COPY frontend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm", "run", "dev"]
