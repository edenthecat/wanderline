#!/usr/bin/env bash
# Apply a CORS policy to the uploads bucket.
#
# Why this is needed at all: with USE_SIGNED_URL_DOWNLOADS=true the
# backend 307-redirects /audio/* to a signed storage.googleapis.com
# URL. A media element follows that redirect happily — <audio> is not
# subject to CORS — so streaming playback looks perfectly healthy. But
# the player's service worker precaches audio with fetch(), which IS
# subject to CORS, and with no policy on the bucket every one of those
# requests is rejected.
#
# The symptom is "Download for offline fails for every file, but the
# story plays fine", which is close to undiagnosable from the outside:
# nothing is logged server-side, because the browser refuses the
# response before the page ever sees it.
#
# Usage:
#   GCS_BUCKET=my-bucket ./scripts/deploy/configure-bucket-cors.sh https://a.example https://b.example
#
# Safe to re-run: the policy is replaced wholesale each time, so pass
# every origin that should be allowed, not just the new one.

set -euo pipefail

: "${GCS_BUCKET:?Set GCS_BUCKET env var}"

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <origin> [origin...]" >&2
  echo "Example: GCS_BUCKET=$GCS_BUCKET $0 https://player.example.com" >&2
  exit 1
fi

# Build the origin array without a JSON tool — these scripts only
# assume bash + gcloud, and adding a jq/python dependency to the
# deploy path for six lines of string building isn't worth it.
origins=""
for origin in "$@"; do
  case "$origin" in
    https://*|http://localhost:*) ;;
    *)
      echo "Refusing non-https origin: $origin" >&2
      echo "Signed-URL audio is only served over https; an http origin would never match." >&2
      exit 1
      ;;
  esac
  # Trailing slashes never match a browser Origin header, which is
  # always scheme://host[:port] with no path. Strip rather than
  # silently shipping a policy that can't match.
  origin="${origin%/}"
  if [ -z "$origins" ]; then
    origins="\"$origin\""
  else
    origins="$origins, \"$origin\""
  fi
done

CORS_FILE=$(mktemp)
trap 'rm -f "$CORS_FILE"' EXIT

# Content-Range / Accept-Ranges must be exposed or Safari can't do
# ranged reads of a cached audio file, which is how it plays all
# media. Range is listed so the preflight accepts it on the way in.
cat > "$CORS_FILE" <<JSON
[
  {
    "origin": [$origins],
    "method": ["GET", "HEAD"],
    "responseHeader": [
      "Content-Type",
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "Range"
    ],
    "maxAgeSeconds": 3600
  }
]
JSON

echo "=== Applying CORS policy to gs://$GCS_BUCKET ==="
cat "$CORS_FILE"
gcloud storage buckets update "gs://$GCS_BUCKET" --cors-file="$CORS_FILE"
echo "Done. Verify with: gcloud storage buckets describe gs://$GCS_BUCKET --format='value(cors_config)'"
