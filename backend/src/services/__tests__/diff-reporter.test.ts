import { generateDiffHtmlReport, generateDiffTextReport } from '../diff-reporter.js';
import type { DiffNode, DiffSummary } from '../diff-reporter.js';

const mockSummary: DiffSummary = {
  totalNodes: 3,
  nodesWithDiff: 1,
  nodesMatching: 1,
  nodesPendingTranscription: 1,
  nodesFailedTranscription: 0,
};

const mockDiffs: DiffNode[] = [
  {
    nodeId: 'start',
    scriptText: 'Hello world',
    transcribedText: 'Hello world',
    transcriptionStatus: 'completed',
    hasDiff: false,
    audioFile: 'start.mp3',
  },
  {
    nodeId: 'chapter1',
    scriptText: 'Original text',
    transcribedText: 'Modified text',
    transcriptionStatus: 'completed',
    hasDiff: true,
    diffDetails: [
      { value: 'Original', removed: true },
      { value: 'Modified', added: true },
      { value: ' text' },
    ],
    audioFile: 'chapter1.mp3',
  },
  {
    nodeId: 'chapter2',
    scriptText: 'Pending text',
    transcribedText: null,
    transcriptionStatus: 'pending',
    hasDiff: false,
  },
];

describe('generateDiffHtmlReport', () => {
  it('should generate valid HTML', () => {
    const html = generateDiffHtmlReport('Test Project', mockDiffs, mockSummary);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
    expect(html).toContain('Test Project');
  });

  it('should include summary stats', () => {
    const html = generateDiffHtmlReport('Test', mockDiffs, mockSummary);
    expect(html).toContain('>3</div>'); // totalNodes
    expect(html).toContain('>1</div>'); // nodesWithDiff and nodesMatching
  });

  it('should show diff details with added/removed spans', () => {
    const html = generateDiffHtmlReport('Test', mockDiffs, mockSummary);
    expect(html).toContain('class="added"');
    expect(html).toContain('class="removed"');
    expect(html).toContain('Modified');
    expect(html).toContain('Original');
  });

  it('should show matching nodes', () => {
    const html = generateDiffHtmlReport('Test', mockDiffs, mockSummary);
    expect(html).toContain('class="match"');
    expect(html).toContain('Hello world');
  });

  it('should show pending transcription status', () => {
    const html = generateDiffHtmlReport('Test', mockDiffs, mockSummary);
    expect(html).toContain('Transcription in progress');
  });

  it('should escape HTML in project name', () => {
    const html = generateDiffHtmlReport('<script>alert("xss")</script>', mockDiffs, mockSummary);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('should show failed transcription status', () => {
    const failedDiff: DiffNode = {
      nodeId: 'failed',
      scriptText: 'Some text',
      transcribedText: null,
      transcriptionStatus: 'failed',
      hasDiff: false,
    };
    const html = generateDiffHtmlReport('Test', [failedDiff], {
      ...mockSummary,
      nodesFailedTranscription: 1,
    });
    expect(html).toContain('Transcription failed');
    expect(html).toContain('failed');
  });
});

describe('generateDiffTextReport', () => {
  it('should generate plain text report', () => {
    const text = generateDiffTextReport('Test Project', mockDiffs, mockSummary);
    expect(text).toContain('SCRIPT DIFF REPORT: Test Project');
    expect(text).toContain('Total Nodes with Audio: 3');
    expect(text).toContain('Nodes with Differences: 1');
  });

  it('should include node details', () => {
    const text = generateDiffTextReport('Test', mockDiffs, mockSummary);
    expect(text).toContain('NODE: start');
    expect(text).toContain('NODE: chapter1');
    expect(text).toContain('Status: OK');
    expect(text).toContain('Status: DIFFERS');
  });

  it('should show audio file names', () => {
    const text = generateDiffTextReport('Test', mockDiffs, mockSummary);
    expect(text).toContain('Audio: start.mp3');
    expect(text).toContain('Audio: chapter1.mp3');
  });

  it('should show N/A for nodes without audio files', () => {
    const text = generateDiffTextReport('Test', mockDiffs, mockSummary);
    expect(text).toContain('Audio: N/A');
  });
});
