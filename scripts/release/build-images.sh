#!/usr/bin/env bash
# Build the three service images (backend / frontend / player-app)
# for local publishing or a mirror push. Mirrors what the release
# workflow does on tag, so a maintainer can rebuild a release
# locally without a re-tag.
#
# Usage:
#   REGISTRY=ghcr.io/edenthecat TAG=1.2.3 ./scripts/release/build-images.sh
#   REGISTRY=us-west1-docker.pkg.dev/my-proj/wanderline TAG=1.2.3 ./scripts/release/build-images.sh
#
# Requires: docker + buildx + a login to the target registry.

set -euo pipefail

: "${REGISTRY:?Set REGISTRY env var (e.g. ghcr.io/<owner> or <region>-docker.pkg.dev/<project>/<repo>)}"
: "${TAG:?Set TAG env var to the semver (e.g. 1.2.3) or SHA to publish}"
: "${PUSH:=true}"

SHORT_SHA=$(git rev-parse --short=8 HEAD)

# player-app isn't its own image — its `dist/` is baked into the
# backend image and served via /api/_player/*. Same shape as CI.
for service in backend frontend; do
  IMAGE="$REGISTRY/wanderline-$service"
  TAGS=("-t" "$IMAGE:$TAG" "-t" "$IMAGE:sha-$SHORT_SHA")

  # `latest` is reserved for production semver — pre-releases
  # (containing `-`) and raw SHAs skip it.
  if [[ ! "$TAG" == *-* ]] && [[ "$TAG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    TAGS+=("-t" "$IMAGE:latest")
  fi

  echo
  echo "=== Building $service — tags: ${TAGS[*]} ==="

  # Push directly from buildx (fastest — no intermediate load into the
  # local daemon). Set PUSH=false to build-only for a smoke test.
  if [ "$PUSH" = "true" ]; then
    ACTION=(--push)
  else
    ACTION=(--load)
  fi

  docker buildx build \
    -f "$service/Dockerfile.prod" \
    "${TAGS[@]}" \
    "${ACTION[@]}" \
    --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
    --label "org.opencontainers.image.version=$TAG" \
    --label "org.opencontainers.image.licenses=MIT" \
    .
done

echo
echo "=== Done ==="
echo "Registry: $REGISTRY"
echo "Tag:      $TAG"
echo "SHA tag:  sha-$SHORT_SHA"
