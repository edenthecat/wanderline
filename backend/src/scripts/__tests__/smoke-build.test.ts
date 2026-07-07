import { jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runSmokeChecks } from '../smoke-build.js';

// unit tests for the headless smoke runner. Builds tiny fake
// build dirs in tmp and asserts each fails / passes for the right
// reason. The runner doesn't need a browser — it walks story.json +
// the audio/ dir directly, so the test surface is just filesystem.

let tmp: string;

function makeBuildDir(name: string, story: object, audioFiles: string[] = []): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'public', 'audio'), { recursive: true });
  writeFileSync(join(dir, 'public', 'story.json'), JSON.stringify(story));
  for (const f of audioFiles) {
    writeFileSync(join(dir, 'public', 'audio', f), 'fake-audio-bytes');
  }
  return dir;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wanderline-smoke-test-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('runSmokeChecks', () => {
  it('passes a complete story with all audio present', () => {
    const dir = makeBuildDir(
      'good',
      {
        id: 's1',
        startNode: 'start',
        nodes: {
          start: {
            content: [{ text: 'hi' }],
            choices: [{ text: 'go', target: 'next' }],
            audio: { voiceover: 'vo.mp3' },
          },
          next: { content: [{ text: 'fin' }], divert: 'END', audio: {} },
        },
      },
      ['vo.mp3'],
    );
    const report = runSmokeChecks(dir);
    expect(report.passing).toBe(3);
    expect(report.total).toBe(3);
  });

  it('flags empty nodes', () => {
    const dir = makeBuildDir('empty', {
      id: 's2',
      startNode: 'start',
      nodes: {
        start: { content: [{ text: 'hi' }], divert: 'next' },
        next: { content: [], choices: [], divert: null },
      },
    });
    const report = runSmokeChecks(dir);
    const empties = report.checks.find((c) => c.label.includes('content'));
    expect(empties?.problems).toContain('empty node: next');
  });

  it('flags unresolved divert and choice targets', () => {
    const dir = makeBuildDir('broken-targets', {
      id: 's3',
      startNode: 'start',
      nodes: {
        start: {
          content: [{ text: 'x' }],
          choices: [{ text: 'a', target: 'ghost' }],
          divert: null,
        },
      },
    });
    const report = runSmokeChecks(dir);
    const targets = report.checks.find((c) => c.label.includes('target resolves'));
    expect(targets?.problems.some((p) => p.includes('ghost'))).toBe(true);
  });

  it('accepts END / DONE as synthetic terminal targets', () => {
    const dir = makeBuildDir('synthetic', {
      id: 's4',
      startNode: 'start',
      nodes: {
        start: {
          content: [{ text: 'fin' }],
          divert: 'END',
          choices: [{ text: 'really fin', target: 'DONE' }],
        },
      },
    });
    const report = runSmokeChecks(dir);
    expect(report.passing).toBe(report.total);
  });

  it('flags missing audio files', () => {
    const dir = makeBuildDir(
      'missing-audio',
      {
        id: 's5',
        startNode: 'start',
        nodes: {
          start: {
            content: [{ text: 'x' }],
            divert: 'END',
            audio: { voiceover: 'absent.mp3' },
          },
        },
      },
      // No audio files materialised.
    );
    const report = runSmokeChecks(dir);
    const audio = report.checks.find((c) => c.label.includes('audio'));
    expect(audio?.problems.some((p) => p.includes('absent.mp3'))).toBe(true);
  });

  it('flags empty (zero-byte) audio files', () => {
    const dir = makeBuildDir('empty-audio', {
      id: 's6',
      startNode: 'start',
      nodes: {
        start: { content: [{ text: 'x' }], divert: 'END', audio: { voiceover: 'zero.mp3' } },
      },
    });
    writeFileSync(join(dir, 'public', 'audio', 'zero.mp3'), '');
    const report = runSmokeChecks(dir);
    const audio = report.checks.find((c) => c.label.includes('audio'));
    expect(audio?.problems.some((p) => p.includes('zero.mp3'))).toBe(true);
  });

  it('reads story.json from the build root when present', () => {
    const dir = join(tmp, 'root-story');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'audio'), { recursive: true });
    writeFileSync(
      join(dir, 'story.json'),
      JSON.stringify({
        id: 's7',
        startNode: 'start',
        nodes: { start: { content: [{ text: 'x' }], divert: 'END' } },
      }),
    );
    const report = runSmokeChecks(dir);
    expect(report.passing).toBe(report.total);
  });
});

// Pre-empts an "unused import" lint warning when jest is bundled but
// not referenced as a value here.
void jest;
