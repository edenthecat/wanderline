// Process-level constants shared across routes + services. Anything
// worth reading from env with a default belongs here so the default
// only lives in one place — a stray override in one route drifting
// away from the rest was a real footgun.

/**
 * Root directory for audio-file storage on local disk (dev + CI +
 * Cloud Run's ephemeral filesystem). GCS-backed prod reads/writes go
 * through the storage service; this dir is for the transient
 * project/<uuid>/*.mp3 shape.
 */
export const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/wanderline-uploads';
