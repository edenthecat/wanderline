#!/usr/bin/env -S node --experimental-strip-types

// headless smoke runner for built Wanderline artifacts.
//
// Runs the same three checks the in-browser smoke.html runner does,
// but directly against the filesystem so CI can fail a deploy on a
// broken build without a headless browser. Accepts either a path to
// a zip artifact (unzipped to a tmp dir) or a path to an already-
// unzipped build directory.
//
// Exit codes:
//   0  every check passed
//   1  at least one check failed (problems dumped as JSON to stderr)
//   2  invocation / IO error
//
// Usage:
//   tsx scripts/smoke-build.ts <path/to/build.zip>
//   tsx scripts/smoke-build.ts <path/to/unzipped-build>
//   tsx scripts/smoke-build.ts <path> --quiet
//
// The --quiet flag suppresses the per-check breakdown and prints only
// the final pass/fail line — useful when piping into a CI status.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  createWriteStream,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import yauzl from 'yauzl';

interface StoryNode {
  id?: string;
  parent?: string | null;
  type?: string;
  content?: Array<unknown>;
  choices?: Array<{ text?: string; target?: string }>;
  divert?: string | null;
  audio?: Record<string, unknown>;
}
interface StoryData {
  id?: string;
  title?: string;
  audioBaseUrl?: string;
  startNode?: string;
  nodes?: Record<string, StoryNode>;
}

interface Check {
  label: string;
  problems: string[];
}
interface Report {
  passing: number;
  total: number;
  checks: Check[];
}

const SYNTHETIC_TARGETS = new Set(['END', 'DONE']);

async function unzipToTmp(zipPath: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'wanderline-smoke-'));
  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) {
        reject(err ?? new Error('failed to open zip'));
        return;
      }
      zip.on('entry', (entry) => {
        const target = join(dir, entry.fileName);
        // zip-slip defence: reject entries that escape the tmp dir.
        if (!target.startsWith(dir)) {
          zip.readEntry();
          return;
        }
        if (entry.fileName.endsWith('/')) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (entryErr, readStream) => {
          if (entryErr || !readStream) {
            reject(entryErr ?? new Error('zip entry read failed'));
            return;
          }
          const parent = dirname(target);
          // mkdtemp guarantees a fresh root and we rejected escaping
          // paths above, so mkdirSync is safe here.
          mkdirSync(parent, { recursive: true });
          const writeStream = createWriteStream(target);
          writeStream.on('close', () => zip.readEntry());
          writeStream.on('error', reject);
          readStream.pipe(writeStream);
        });
      });
      zip.on('end', () => resolve());
      zip.on('error', reject);
      zip.readEntry();
    });
  });
  return dir;
}

function readStory(buildDir: string): StoryData {
  // story.json may sit at the build root (smoke.html sibling, post-
  // layout) or under public/ (older builds before the player
  // bundle inlined the story). Try both.
  const candidates = [join(buildDir, 'story.json'), join(buildDir, 'public', 'story.json')];
  for (const path of candidates) {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8')) as StoryData;
    }
  }
  // Fall back to grepping the inlined payload out of smoke.html or
  // index.html — both carry `window.__WANDERLINE_STORY__ = {...}`.
  for (const file of ['smoke.html', 'index.html']) {
    const path = join(buildDir, file);
    if (!existsSync(path)) continue;
    const html = readFileSync(path, 'utf-8');
    const match = /window\.__WANDERLINE_STORY__\s*=\s*(\{[\s\S]*?\});/.exec(html);
    if (match) {
      try {
        // The inlined payload uses \uXXXX escapes (e.g. \u003c,
        // \u2028) which JSON.parse handles natively. No
        // transformation needed before parsing.
        return JSON.parse(match[1]) as StoryData;
      } catch {
        // fall through
      }
    }
  }
  throw new Error('Could not find story.json or an inlined story payload in the build');
}

function checkNodeCompleteness(nodes: Record<string, StoryNode>): Check {
  const problems: string[] = [];
  for (const [id, n] of Object.entries(nodes)) {
    const hasContent = Array.isArray(n.content) && n.content.length > 0;
    const hasChoices = Array.isArray(n.choices) && n.choices.length > 0;
    const hasDivert = typeof n.divert === 'string' && n.divert.length > 0;
    if (!hasContent && !hasChoices && !hasDivert) problems.push(`empty node: ${id}`);
  }
  return { label: 'Every node has content, a divert, or choices', problems };
}

// Resolve a divert / choice target the way Ink does:
//   1. END / DONE are synthetic terminal sinks.
//   2. Exact top-level node id wins.
//   3. Otherwise, look for a sibling stitch — i.e. `${scope}.${target}`
//      where `scope` is the source knot (its parent when source is a
//      stitch, or the source itself when it's a knot).
function resolveTarget(
  sourceId: string,
  target: string,
  nodes: Record<string, StoryNode>,
): boolean {
  if (SYNTHETIC_TARGETS.has(target)) return true;
  if (Object.prototype.hasOwnProperty.call(nodes, target)) return true;
  const source = nodes[sourceId];
  const knot = source?.parent ?? sourceId;
  return Object.prototype.hasOwnProperty.call(nodes, `${knot}.${target}`);
}

function checkTargets(nodes: Record<string, StoryNode>): Check {
  const problems: string[] = [];
  for (const [id, n] of Object.entries(nodes)) {
    if (n.divert && !resolveTarget(id, n.divert, nodes)) {
      problems.push(`${id} diverts to ${n.divert}`);
    }
    (n.choices || []).forEach((c, idx) => {
      if (c && c.target && !resolveTarget(id, c.target, nodes)) {
        problems.push(`${id} choice ${idx + 1} → ${c.target}`);
      }
    });
  }
  return { label: 'Every divert / choice target resolves', problems };
}

function collectAudioRefs(nodes: Record<string, StoryNode>): string[] {
  const seen = new Set<string>();
  for (const n of Object.values(nodes)) {
    const audio = n.audio ?? {};
    for (const v of Object.values(audio)) {
      if (typeof v === 'string' && v && !seen.has(v)) seen.add(v);
    }
  }
  return [...seen];
}

function checkAudio(buildDir: string, audioRefs: string[]): Check {
  const problems: string[] = [];
  // Audio is laid out under public/audio/<filename> in the build dir.
  const candidates = [join(buildDir, 'public', 'audio'), join(buildDir, 'audio')];
  const audioDir = candidates.find((p) => existsSync(p));
  if (!audioDir && audioRefs.length > 0) {
    return {
      label: 'Every referenced audio file is reachable',
      problems: ['build has no audio/ directory but the story references audio files'],
    };
  }
  for (const filename of audioRefs) {
    if (!audioDir) continue;
    const path = join(audioDir, filename);
    if (!existsSync(path)) {
      problems.push(`${filename} (missing)`);
      continue;
    }
    if (statSync(path).size === 0) {
      problems.push(`${filename} (empty)`);
    }
  }
  return { label: 'Every referenced audio file is reachable', problems };
}

export function runSmokeChecks(buildDir: string): Report {
  const story = readStory(buildDir);
  const nodes = story.nodes ?? {};
  const audioRefs = collectAudioRefs(nodes);
  const checks: Check[] = [
    checkNodeCompleteness(nodes),
    checkTargets(nodes),
    checkAudio(buildDir, audioRefs),
  ];
  const passing = checks.filter((c) => c.problems.length === 0).length;
  return { passing, total: checks.length, checks };
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const quiet = args.includes('--quiet');
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) {
    process.stderr.write('usage: smoke-build.ts <path-to-build.zip-or-dir> [--quiet]\n');
    return 2;
  }
  if (!existsSync(target)) {
    process.stderr.write(`smoke-build: ${target} does not exist\n`);
    return 2;
  }

  let buildDir: string;
  let cleanup: (() => void) | null = null;
  if (statSync(target).isDirectory()) {
    buildDir = target;
  } else {
    buildDir = await unzipToTmp(target);
    cleanup = () => rmSync(buildDir, { recursive: true, force: true });
  }

  try {
    const report = runSmokeChecks(buildDir);
    if (!quiet) {
      for (const c of report.checks) {
        const ok = c.problems.length === 0;
        process.stdout.write(`${ok ? '✓' : '✗'} ${c.label}\n`);
        for (const p of c.problems) process.stdout.write(`    • ${p}\n`);
      }
    }
    const failed = report.checks.filter((c) => c.problems.length > 0);
    if (failed.length > 0) {
      process.stderr.write(
        JSON.stringify({ passing: report.passing, total: report.total, problems: failed }) + '\n',
      );
      process.stdout.write(`smoke: ${report.passing}/${report.total} passing (fail)\n`);
      return 1;
    }
    process.stdout.write(`smoke: ${report.passing}/${report.total} passing (ok)\n`);
    return 0;
  } finally {
    cleanup?.();
  }
}

// Run as CLI when invoked directly. Detect by comparing argv[1] to the
// resolved module URL — works under node (dist .js) and tsx (.ts).
const argv1 = process.argv[1] ?? '';
const isCli = argv1.endsWith('smoke-build.ts') || argv1.endsWith('smoke-build.js');
if (isCli) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`smoke-build: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    },
  );
}
