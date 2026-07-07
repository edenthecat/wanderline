import { nodewhisper } from 'nodejs-whisper';
import { Pool } from 'pg';
import { join } from 'path';
import { existsSync, statSync } from 'fs';
import { logger } from '../logger.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/wanderline-uploads';

// Whisper model to use (tiny is fastest, base is good balance)
// Models: tiny, base, small, medium, large
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'base';

// Model sizes in bytes (approximate)
const MODEL_SIZES: Record<string, number> = {
  tiny: 75_000_000, // ~75MB
  'tiny.en': 75_000_000,
  base: 142_000_000, // ~142MB
  'base.en': 142_000_000,
  small: 466_000_000, // ~466MB
  'small.en': 466_000_000,
  medium: 1_500_000_000, // ~1.5GB
  'medium.en': 1_500_000_000,
  large: 2_900_000_000, // ~2.9GB
};

// Track download status globally
export interface WhisperModelStatus {
  model: string;
  isDownloaded: boolean;
  isDownloading: boolean;
  downloadProgress: number; // 0-100
  expectedSize: number;
  currentSize: number;
  error?: string;
}

let modelStatus: WhisperModelStatus = {
  model: WHISPER_MODEL,
  isDownloaded: false,
  isDownloading: false,
  downloadProgress: 0,
  expectedSize: MODEL_SIZES[WHISPER_MODEL] || 142_000_000,
  currentSize: 0,
};

/**
 * Get the path to the whisper model file
 */
function getModelPath(): string {
  // nodejs-whisper stores models in node_modules/nodejs-whisper/cpp/whisper.cpp/models/
  const modelFileName = `ggml-${WHISPER_MODEL}.bin`;
  return join(
    process.cwd(),
    'node_modules',
    'nodejs-whisper',
    'cpp',
    'whisper.cpp',
    'models',
    modelFileName,
  );
}

// Flag to track if we've explicitly started a download
let explicitlyDownloading = false;

/**
 * Check if the whisper model is downloaded by checking file existence and size
 */
export function checkModelStatus(): WhisperModelStatus {
  const modelPath = getModelPath();
  const expectedSize = MODEL_SIZES[WHISPER_MODEL] || 142_000_000;

  if (existsSync(modelPath)) {
    try {
      const stats = statSync(modelPath);
      const isComplete = stats.size >= expectedSize * 0.95; // Allow 5% tolerance

      // If complete, mark as downloaded and not downloading
      if (isComplete) {
        explicitlyDownloading = false;
        modelStatus = {
          ...modelStatus,
          isDownloaded: true,
          isDownloading: false,
          currentSize: stats.size,
          downloadProgress: 100,
        };
      } else {
        // File exists but not complete - it's downloading
        modelStatus = {
          ...modelStatus,
          isDownloaded: false,
          isDownloading: true,
          currentSize: stats.size,
          downloadProgress: Math.min(99, Math.round((stats.size / expectedSize) * 100)),
        };
      }
    } catch {
      // File might be in use or inaccessible
    }
  } else {
    // File doesn't exist - preserve isDownloading state if explicitly set
    modelStatus = {
      ...modelStatus,
      isDownloaded: false,
      isDownloading: explicitlyDownloading,
      currentSize: 0,
      downloadProgress: 0,
    };
  }

  return modelStatus;
}

/**
 * Mark that we're starting a download
 */
export function setDownloadingState(downloading: boolean): void {
  explicitlyDownloading = downloading;
  modelStatus.isDownloading = downloading;
}

/**
 * Get current whisper model status
 */
export function getWhisperModelStatus(): WhisperModelStatus {
  return checkModelStatus();
}

export interface TranscriptionResult {
  success: boolean;
  transcription?: string;
  error?: string;
}

/**
 * Transcribe an audio file using local Whisper (whisper.cpp)
 */
export async function transcribeAudio(
  pool: Pool,
  audioFileId: string,
  projectId: string,
): Promise<TranscriptionResult> {
  try {
    // Mark as processing
    await pool.query(`UPDATE audio_files SET transcription_status = 'processing' WHERE id = $1`, [
      audioFileId,
    ]);

    // Get the file info
    const fileResult = await pool.query(
      'SELECT filename, original_name, mime_type FROM audio_files WHERE id = $1',
      [audioFileId],
    );

    if (fileResult.rows.length === 0) {
      return { success: false, error: 'Audio file not found' };
    }

    const { filename } = fileResult.rows[0];
    const filePath = join(UPLOAD_DIR, projectId, filename);

    if (!existsSync(filePath)) {
      await pool.query(
        `UPDATE audio_files SET transcription_status = 'failed', transcription_error = 'Audio file not found on disk' WHERE id = $1`,
        [audioFileId],
      );
      return { success: false, error: 'Audio file not found on disk' };
    }

    logger.info({ filename, model: WHISPER_MODEL }, 'Starting transcription');

    // Check if model needs to be downloaded
    const status = checkModelStatus();
    const needsDownload = !status.isDownloaded;
    if (needsDownload) {
      logger.info(
        { model: WHISPER_MODEL },
        'Whisper model not found, will be downloaded automatically',
      );
      setDownloadingState(true);
    }

    // Run whisper.cpp transcription (will auto-download model if needed)
    const result = await nodewhisper(filePath, {
      modelName: WHISPER_MODEL,
      autoDownloadModelName: WHISPER_MODEL,
      removeWavFileAfterTranscription: true,
      withCuda: false, // CPU only for now
      whisperOptions: {
        outputInText: true,
        outputInSrt: false,
        outputInVtt: false,
        wordTimestamps: false,
      },
    });

    // Model is now downloaded (if it wasn't before)
    if (needsDownload) {
      logger.info({ model: WHISPER_MODEL }, 'Whisper model download complete');
      setDownloadingState(false);
      checkModelStatus(); // Update status to reflect downloaded state
    }

    // Extract text from result
    let transcription = '';
    if (Array.isArray(result)) {
      transcription = result
        .map((segment: { speech: string }) => segment.speech)
        .join(' ')
        .trim();
    } else if (typeof result === 'string') {
      transcription = result.trim();
    }

    // Strip timestamps from transcription (formats like [00:00:00.000 --> 00:00:05.000] or [00:00.000 --> 00:05.000])
    transcription = transcription
      .replace(
        /\[\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{3})?\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{3})?\]\s*/g,
        '',
      )
      .replace(
        /\(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{3})?\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{3})?\)\s*/g,
        '',
      )
      .replace(
        /\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{3})?\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{3})?\s*/g,
        '',
      )
      .replace(/\s+/g, ' ')
      .trim();

    if (!transcription) {
      await pool.query(
        `UPDATE audio_files SET transcription_status = 'failed', transcription_error = 'No speech detected' WHERE id = $1`,
        [audioFileId],
      );
      return { success: false, error: 'No speech detected' };
    }

    // Store the result
    await pool.query(
      `UPDATE audio_files SET transcription = $1, transcription_status = 'completed', transcription_error = NULL WHERE id = $2`,
      [transcription, audioFileId],
    );

    logger.info({ filename, preview: transcription.substring(0, 100) }, 'Transcription completed');

    return { success: true, transcription };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error }, 'Transcription failed');

    // Store the error
    await pool.query(
      `UPDATE audio_files SET transcription_status = 'failed', transcription_error = $1 WHERE id = $2`,
      [errorMessage, audioFileId],
    );

    return { success: false, error: errorMessage };
  }
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Trigger transcription for an audio file with retries (runs in background)
 */
export function triggerTranscription(pool: Pool, audioFileId: string, projectId: string): void {
  // Run transcription in background with retries
  (async () => {
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const result = await transcribeAudio(pool, audioFileId, projectId);

      if (result.success) {
        return; // Success, we're done
      }

      lastError = result.error;

      // Don't retry for certain errors that won't be fixed by retrying
      if (
        result.error === 'Audio file not found' ||
        result.error === 'Audio file not found on disk'
      ) {
        logger.error({ resultError: result.error }, 'Transcription failed (not retrying)');
        return;
      }

      if (attempt < MAX_RETRIES) {
        logger.warn(
          { attempt, retryDelayMs: RETRY_DELAY_MS, resultError: result.error },
          'Transcription attempt failed, retrying',
        );
        await sleep(RETRY_DELAY_MS);
      }
    }

    logger.error({ attempts: MAX_RETRIES, lastError }, 'Transcription failed after all attempts');
  })().catch((err) => {
    logger.error({ err }, 'Background transcription failed');
  });
}

/**
 * Get transcription status for an audio file
 */
export async function getTranscriptionStatus(
  pool: Pool,
  audioFileId: string,
): Promise<{ status: string; transcription?: string; error?: string } | null> {
  const result = await pool.query(
    'SELECT transcription, transcription_status, transcription_error FROM audio_files WHERE id = $1',
    [audioFileId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const { transcription, transcription_status, transcription_error } = result.rows[0];
  return {
    status: transcription_status || 'pending',
    transcription: transcription || undefined,
    error: transcription_error || undefined,
  };
}

/**
 * Manually trigger re-transcription for an audio file
 */
export async function retryTranscription(
  pool: Pool,
  audioFileId: string,
  projectId: string,
): Promise<TranscriptionResult> {
  // Reset status first
  await pool.query(
    `UPDATE audio_files SET transcription_status = 'pending', transcription_error = NULL WHERE id = $1`,
    [audioFileId],
  );

  return transcribeAudio(pool, audioFileId, projectId);
}
