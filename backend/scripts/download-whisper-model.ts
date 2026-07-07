import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const WHISPER_MODEL = process.env.WHISPER_MODEL || 'base';

async function downloadModel() {
  if (WHISPER_MODEL === 'skip') {
    console.log('Skipping Whisper model download (WHISPER_MODEL=skip)');
    return;
  }

  const modelPath = join(
    process.cwd(),
    'node_modules',
    'nodejs-whisper',
    'cpp',
    'whisper.cpp',
    'models',
    `ggml-${WHISPER_MODEL}.bin`,
  );
  const whisperBinary = join(
    process.cwd(),
    'node_modules',
    'nodejs-whisper',
    'cpp',
    'whisper.cpp',
    'build',
    'bin',
    'whisper-cli',
  );

  if (existsSync(modelPath) && existsSync(whisperBinary)) {
    console.log(`Whisper model '${WHISPER_MODEL}' and binary already exist.`);
    return;
  }

  console.log(`Setting up Whisper model '${WHISPER_MODEL}'... This may take a few minutes.`);

  // Create a minimal audio file to trigger model download
  const testFile = '/tmp/whisper-init.wav';
  try {
    execSync(`ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -y ${testFile}`, { stdio: 'pipe' });
  } catch {
    console.log('Could not create test audio file');
  }

  try {
    // Import dynamically to trigger the download
    const { nodewhisper } = await import('nodejs-whisper');

    if (existsSync(testFile)) {
      // This will download the model and build whisper.cpp
      // We catch the "no output" error since silence produces no transcription
      await nodewhisper(testFile, {
        modelName: WHISPER_MODEL,
        autoDownloadModelName: WHISPER_MODEL,
        removeWavFileAfterTranscription: true,
        withCuda: false,
        whisperOptions: {
          outputInText: true,
        },
      }).catch(() => {
        // Expected - silence produces no output
      });
    }

    // Verify the model was downloaded
    if (existsSync(modelPath)) {
      console.log(`Whisper model '${WHISPER_MODEL}' downloaded successfully!`);
    } else {
      throw new Error('Model file not found after download attempt');
    }

    // Verify whisper binary was built
    if (existsSync(whisperBinary)) {
      console.log('Whisper binary built successfully!');
    } else {
      throw new Error('Whisper binary not found after build attempt');
    }
  } catch (error) {
    // Check if model exists despite the error (silence test file issue)
    if (existsSync(modelPath) && existsSync(whisperBinary)) {
      console.log(`Whisper model '${WHISPER_MODEL}' setup completed successfully!`);
    } else {
      console.error('Failed to setup Whisper:', error);
      process.exit(1);
    }
  }
}

downloadModel();
