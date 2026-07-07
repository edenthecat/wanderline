-- Drop the three transcription-related columns from audio_files.
--
-- These backed the automatic Whisper transcription feature, which is
-- gone. The manual per-node caption text lives on node_metadata.transcript
-- and is unaffected.

ALTER TABLE audio_files DROP COLUMN IF EXISTS transcription;
ALTER TABLE audio_files DROP COLUMN IF EXISTS transcription_status;
ALTER TABLE audio_files DROP COLUMN IF EXISTS transcription_error;
