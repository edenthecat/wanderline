import { existsSync, mkdirSync, copyFileSync, statSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import type { StoryData, AudioFileRow, StoryDataNodeAudio } from './story-data-builder.js';
import { logger } from '../logger.js';

export interface ProcessedAudioFile {
  srcPath: string;
  archiveName: string;
  sizeBytes: number;
}

export interface ProcessedAudioResult {
  files: ProcessedAudioFile[];
  totalSizeBytes: number;
  audioSizeBytes: number;
  filenameMapping: Record<string, string>;
  copiedCount: number;
  skippedCount: number;
  convertedCount: number;
}

/**
 * Collects all audio filenames referenced in the story data.
 */
export function collectUsedAudioFilenames(
  storyData: StoryData,
  settings: Record<string, unknown>,
  fileMap: Record<string, string>,
  backgroundMusicFiles: string[],
): Set<string> {
  const usedFilenames = new Set<string>();

  // Add node audio assignments. Each slot can now hold several
  // variable-conditioned candidates (DEV-199 follow-on) rather than
  // one fixed file — a static export bundle must ship every
  // candidate, since the player decides at runtime (from live
  // variable state) which one actually plays.
  for (const nodeId of Object.keys(storyData.nodes)) {
    const node = storyData.nodes[nodeId];
    for (const slot of ['voiceover', 'ambience', 'choice1', 'choice2'] as const) {
      for (const variant of node.audio?.[slot] ?? []) usedFilenames.add(variant.file);
    }
    for (const variants of Object.values(node.audio?.choices ?? {})) {
      for (const variant of variants) usedFilenames.add(variant.file);
    }
    for (const fx of node.audio?.sfx ?? []) usedFilenames.add(fx.file);
  }

  // Add indicator audio from settings
  const indicatorSettings =
    (settings as Record<string, Record<string, string>>).choiceIndicatorAudio || {};
  if (indicatorSettings.choice1FileId && fileMap[indicatorSettings.choice1FileId]) {
    usedFilenames.add(fileMap[indicatorSettings.choice1FileId]);
  }
  if (indicatorSettings.choice2FileId && fileMap[indicatorSettings.choice2FileId]) {
    usedFilenames.add(fileMap[indicatorSettings.choice2FileId]);
  }

  // Add background music
  for (const musicFile of backgroundMusicFiles) {
    usedFilenames.add(musicFile);
  }

  return usedFilenames;
}

export interface ProcessAudioOptions {
  /** Where uploaded audio files live on disk */
  projectAudioDir: string;
  /** Temp directory for WAV-to-MP3 conversion */
  tempConvertDir?: string;
  /** Where to copy files for a disk-based build (sync generate). If not provided, files are tracked but not copied. */
  outputAudioDir?: string;
  /** If true, throw on missing audio files. Otherwise just log warnings. */
  throwOnMissing?: boolean;
}

/**
 * Processes audio files for a build: identifies used files, converts WAV to MP3,
 * copies/tracks files, and updates storyData references.
 *
 * This was previously duplicated in sync and async generation paths.
 */
export function processAudioForBuild(
  storyData: StoryData,
  audioFiles: AudioFileRow[],
  fileMap: Record<string, string>,
  usedFilenames: Set<string>,
  options: ProcessAudioOptions,
): ProcessedAudioResult {
  const { projectAudioDir, tempConvertDir, outputAudioDir, throwOnMissing = true } = options;

  if (tempConvertDir) {
    mkdirSync(tempConvertDir, { recursive: true });
  }

  const missingAudioFiles: string[] = [];
  let copiedCount = 0;
  let skippedCount = 0;
  let convertedCount = 0;
  const filenameMapping: Record<string, string> = {};
  const processedFiles: ProcessedAudioFile[] = [];
  let audioSizeBytes = 0;

  for (const file of audioFiles) {
    if (!usedFilenames.has(file.filename)) {
      skippedCount++;
      continue;
    }

    const srcPath = join(projectAudioDir, file.filename);
    if (!existsSync(srcPath)) {
      missingAudioFiles.push(file.original_name || file.filename);
      continue;
    }

    // Check if it's a WAV file that needs conversion
    const isWav =
      file.filename.toLowerCase().endsWith('.wav') ||
      file.mime_type === 'audio/wav' ||
      file.mime_type === 'audio/x-wav';

    if (isWav && tempConvertDir) {
      const mp3Filename = file.filename.replace(/\.wav$/i, '.mp3');

      if (outputAudioDir) {
        // Sync path: convert directly to output directory
        const destPath = join(outputAudioDir, mp3Filename);
        try {
          execFileSync(
            'ffmpeg',
            ['-i', srcPath, '-codec:a', 'libmp3lame', '-q:a', '2', destPath, '-y'],
            { stdio: 'pipe' },
          );
          filenameMapping[file.filename] = mp3Filename;
          const fileSize = statSync(destPath).size;
          processedFiles.push({
            srcPath: destPath,
            archiveName: `public/audio/${mp3Filename}`,
            sizeBytes: fileSize,
          });
          audioSizeBytes += fileSize;
          convertedCount++;
          copiedCount++;
        } catch {
          // If conversion fails, copy original
          logger.warn({ filename: file.filename }, 'Failed to convert to MP3, copying as-is');
          const destPath2 = join(outputAudioDir, file.filename);
          copyFileSync(srcPath, destPath2);
          const fileSize = statSync(destPath2).size;
          processedFiles.push({
            srcPath: destPath2,
            archiveName: `public/audio/${file.filename}`,
            sizeBytes: fileSize,
          });
          audioSizeBytes += fileSize;
          copiedCount++;
        }
      } else {
        // Async path: convert to temp directory for archiving
        const convertedPath = join(tempConvertDir, mp3Filename);
        try {
          execFileSync(
            'ffmpeg',
            ['-i', srcPath, '-codec:a', 'libmp3lame', '-q:a', '2', convertedPath, '-y'],
            { stdio: 'pipe' },
          );
          filenameMapping[file.filename] = mp3Filename;
          const fileSize = statSync(convertedPath).size;
          processedFiles.push({
            srcPath: convertedPath,
            archiveName: `public/audio/${mp3Filename}`,
            sizeBytes: fileSize,
          });
          audioSizeBytes += fileSize;
          convertedCount++;
          copiedCount++;
        } catch {
          logger.warn({ filename: file.filename }, 'Failed to convert to MP3, using original');
          const fileSize = statSync(srcPath).size;
          processedFiles.push({
            srcPath,
            archiveName: `public/audio/${file.filename}`,
            sizeBytes: fileSize,
          });
          audioSizeBytes += fileSize;
          copiedCount++;
        }
      }
    } else {
      if (outputAudioDir) {
        // Sync path: copy to output directory
        const destPath = join(outputAudioDir, file.filename);
        copyFileSync(srcPath, destPath);
        const fileSize = statSync(destPath).size;
        processedFiles.push({
          srcPath: destPath,
          archiveName: `public/audio/${file.filename}`,
          sizeBytes: fileSize,
        });
        audioSizeBytes += fileSize;
      } else {
        // Async path: reference original for archiving
        const fileSize = statSync(srcPath).size;
        processedFiles.push({
          srcPath,
          archiveName: `public/audio/${file.filename}`,
          sizeBytes: fileSize,
        });
        audioSizeBytes += fileSize;
      }
      copiedCount++;
    }
  }

  // Build set of available files
  const availableFiles = new Set<string>();
  for (const { archiveName } of processedFiles) {
    const filename = archiveName.split('/').pop();
    if (filename) availableFiles.add(filename);
  }

  // Update storyData: convert filenames and remove missing audio
  updateStoryDataFilenames(storyData, filenameMapping, availableFiles);

  if (missingAudioFiles.length > 0 && throwOnMissing) {
    const fileList = missingAudioFiles.slice(0, 10).join(', ');
    const moreText =
      missingAudioFiles.length > 10 ? ` and ${missingAudioFiles.length - 10} more` : '';
    throw new Error(
      `Cannot generate app: ${missingAudioFiles.length} audio file(s) could not be staged from storage. Please re-upload or reassign: ${fileList}${moreText}`,
    );
  }

  logger.info(
    { copiedCount, skippedCount, convertedCount },
    'Audio: build summary (included / skipped unassigned / converted WAV→MP3)',
  );

  return {
    files: processedFiles,
    totalSizeBytes: audioSizeBytes, // will be updated with code size later
    audioSizeBytes,
    filenameMapping,
    copiedCount,
    skippedCount,
    convertedCount,
  };
}

/**
 * Updates story data filenames after WAV-to-MP3 conversion,
 * and removes references to missing audio files.
 *
 * Exported for tests.
 */
export function updateStoryDataFilenames(
  storyData: StoryData,
  filenameMapping: Record<string, string>,
  availableFiles: Set<string>,
): void {
  for (const nodeId of Object.keys(storyData.nodes)) {
    const node = storyData.nodes[nodeId];
    if (node.audio) {
      for (const slot of ['voiceover', 'ambience', 'choice1', 'choice2'] as const) {
        updateOrRemoveAudioVariants(node.audio, slot, filenameMapping, availableFiles);
      }
      // Same rename-or-drop as the single slots: a WAV converted to MP3
      // is renamed, and a file missing from the build is dropped rather
      // than left for the player to 404 on.
      if (node.audio.sfx) {
        node.audio.sfx = node.audio.sfx
          .map((fx) => ({ ...fx, file: filenameMapping[fx.file] || fx.file }))
          .filter((fx) => availableFiles.has(fx.file));
        if (node.audio.sfx.length === 0) delete node.audio.sfx;
      }
    }
  }

  // Update indicator audio
  if (storyData.indicatorAudio) {
    updateOrRemoveAudioRef(storyData.indicatorAudio, 'choice1', filenameMapping, availableFiles);
    updateOrRemoveAudioRef(storyData.indicatorAudio, 'choice2', filenameMapping, availableFiles);
  }

  // Update background music
  if (storyData.backgroundMusic && Array.isArray(storyData.backgroundMusic)) {
    storyData.backgroundMusic = storyData.backgroundMusic
      .map((f) => filenameMapping[f] || f)
      .filter((f) => availableFiles.has(f));
    if (storyData.backgroundMusic.length === 0) {
      delete (storyData as { backgroundMusic?: string[] }).backgroundMusic;
    }
  }
}

function updateOrRemoveAudioRef<K extends string>(
  obj: Partial<Record<K, string>>,
  key: K,
  filenameMapping: Record<string, string>,
  availableFiles: Set<string>,
): void {
  const value = obj[key];
  if (!value) return;

  const converted = filenameMapping[value];
  if (converted) {
    obj[key] = converted;
  } else if (!availableFiles.has(value)) {
    delete obj[key];
  }
}

/**
 * Same rename-or-drop as updateOrRemoveAudioRef, for a node audio
 * slot that now holds a list of variable-conditioned candidates
 * instead of a single filename. Each candidate is renamed/dropped
 * independently; the slot itself is removed if every candidate ends
 * up dropped.
 */
function updateOrRemoveAudioVariants(
  audio: StoryDataNodeAudio,
  slot: 'voiceover' | 'ambience' | 'choice1' | 'choice2',
  filenameMapping: Record<string, string>,
  availableFiles: Set<string>,
): void {
  const variants = audio[slot];
  if (!variants) return;
  const updated = variants
    .map((variant) => ({ ...variant, file: filenameMapping[variant.file] || variant.file }))
    .filter((variant) => availableFiles.has(variant.file));
  if (updated.length === 0) {
    delete audio[slot];
  } else {
    audio[slot] = updated;
  }
}
