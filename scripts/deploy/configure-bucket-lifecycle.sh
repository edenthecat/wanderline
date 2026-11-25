#!/usr/bin/env bash
# Apply a storage lifecycle policy to the uploads bucket.
#
# This policy deliberately contains NO delete rules. That is the whole
# design decision, so it's worth stating why, because "expire old
# objects" is the obvious thing to reach for and it would lose data
# here:
#
#   builds/<id>.zip — build snapshots. The app already manages
#     retention itself: at MAX_BUILDS_PER_PROJECT it soft-deletes the
#     oldest NON-PINNED build, and if every build is pinned it refuses
#     the new build with "unpin one first" rather than evicting one. So
#     a pinned snapshot is a promise that it sticks around until the
#     author unpins it. An age-based delete rule cannot see that
#     promise — lifecycle conditions match on age and prefix, not on a
#     database column — so it would delete exactly the builds the app
#     guarantees to keep.
#
#   audio/<projectId>/<file> — live audio, referenced by stories for as
#     long as the project exists. Age says nothing about whether a file
#     is still in use: the oldest audio in a project is usually its
#     intro, i.e. the single most-played file.
#
# What's left is the part that is safe and still saves money:
#
#   1. Move builds/ to NEARLINE after 30 days. Snapshots are written
#      once and downloaded rarely afterwards, which is the access
#      pattern NEARLINE exists for — roughly half the per-GB storage
#      price in exchange for a per-GB retrieval fee. These zips bundle
#      story JSON + audio + the player bundle, so they are the largest
#      objects in the bucket by a wide margin. Transitioning is not
#      deleting: a pinned build moved to NEARLINE is still there and
#      still downloadable, just cheaper to keep and slightly dearer to
#      fetch. 30 days (not less) because NEARLINE bills a 30-day
#      minimum storage duration, so transitioning earlier can cost more
#      than it saves.
#
#   2. Abort incomplete multipart uploads after 7 days. A failed or
#      abandoned upload leaves parts that are invisible in listings but
#      still billed as stored bytes. Nothing references them and
#      nothing will ever complete them.
#
# Usage:
#   GCS_BUCKET=my-bucket ./scripts/deploy/configure-bucket-lifecycle.sh
#
# Idempotent: writes the same policy every time, so re-running after a
# deploy is a no-op. Unlike the CORS script there is nothing to merge —
# this policy is the complete intended state, and a stray hand-added
# delete rule is something we want overwritten rather than preserved.

set -euo pipefail

: "${GCS_BUCKET:?Set GCS_BUCKET env var}"

BUILDS_NEARLINE_AFTER_DAYS="${BUILDS_NEARLINE_AFTER_DAYS:-30}"
ABORT_INCOMPLETE_AFTER_DAYS="${ABORT_INCOMPLETE_AFTER_DAYS:-7}"

if [ "$BUILDS_NEARLINE_AFTER_DAYS" -lt 30 ]; then
  echo "Refusing BUILDS_NEARLINE_AFTER_DAYS=$BUILDS_NEARLINE_AFTER_DAYS (< 30)." >&2
  echo "NEARLINE bills a 30-day minimum storage duration; transitioning earlier" >&2
  echo "incurs an early-deletion charge for the remainder and can cost more than" >&2
  echo "leaving the object in STANDARD." >&2
  exit 1
fi

LIFECYCLE_FILE=$(mktemp)
trap 'rm -f "$LIFECYCLE_FILE"' EXIT

cat > "$LIFECYCLE_FILE" <<JSON
{
  "rule": [
    {
      "action": {
        "type": "SetStorageClass",
        "storageClass": "NEARLINE"
      },
      "condition": {
        "age": $BUILDS_NEARLINE_AFTER_DAYS,
        "matchesPrefix": ["builds/"]
      }
    },
    {
      "action": {
        "type": "AbortIncompleteMultipartUpload"
      },
      "condition": {
        "age": $ABORT_INCOMPLETE_AFTER_DAYS
      }
    }
  ]
}
JSON

echo "=== Applying lifecycle policy to gs://$GCS_BUCKET ==="
cat "$LIFECYCLE_FILE"
gcloud storage buckets update "gs://$GCS_BUCKET" --lifecycle-file="$LIFECYCLE_FILE"
echo
echo "Done. No delete rules were applied — see the comment at the top of"
echo "this script for why age-based deletion is unsafe for both prefixes."
echo "Verify with: gcloud storage buckets describe gs://$GCS_BUCKET --format='value(lifecycle_config)'"
