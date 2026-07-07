/**
 * Generates diff reports comparing original Ink script text to transcribed audio.
 * Extracted from projects.ts for reuse.
 */

export interface DiffNode {
  nodeId: string;
  scriptText: string;
  transcribedText: string | null;
  transcriptionStatus: string;
  hasDiff: boolean;
  diffDetails?: Array<{ value: string; added?: boolean; removed?: boolean }>;
  audioFile?: string;
}

export interface DiffSummary {
  totalNodes: number;
  nodesWithDiff: number;
  nodesMatching: number;
  nodesPendingTranscription: number;
  nodesFailedTranscription: number;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function generateDiffHtmlReport(
  projectName: string,
  diffs: DiffNode[],
  summary: DiffSummary,
): string {
  const diffHtml = diffs
    .map((d) => {
      let diffContent = '';
      if (d.hasDiff && d.diffDetails) {
        diffContent = d.diffDetails
          .map((part) => {
            if (part.added) return `<span class="added">${escapeHtml(part.value)}</span>`;
            if (part.removed) return `<span class="removed">${escapeHtml(part.value)}</span>`;
            return escapeHtml(part.value);
          })
          .join('');
      } else if (!d.hasDiff && d.transcribedText) {
        diffContent = `<span class="match">${escapeHtml(d.transcribedText)}</span>`;
      } else if (d.transcriptionStatus === 'pending' || d.transcriptionStatus === 'processing') {
        diffContent = '<em class="pending">Transcription in progress...</em>';
      } else if (d.transcriptionStatus === 'failed') {
        diffContent = '<em class="failed">Transcription failed</em>';
      } else {
        diffContent = '<em class="no-transcription">No transcription available</em>';
      }

      const statusClass = d.hasDiff
        ? 'has-diff'
        : d.transcribedText
          ? 'match'
          : d.transcriptionStatus === 'failed'
            ? 'failed'
            : 'pending';

      return `
      <div class="node ${statusClass}">
        <div class="node-header">
          <strong>${escapeHtml(d.nodeId)}</strong>
          ${d.audioFile ? `<span class="audio-file">${escapeHtml(d.audioFile)}</span>` : ''}
          <span class="status-badge ${d.hasDiff ? 'diff' : 'ok'}">${d.hasDiff ? 'DIFFERS' : 'OK'}</span>
        </div>
        <div class="script-section">
          <div class="label">Script:</div>
          <div class="text">${escapeHtml(d.scriptText) || '<em>No script text</em>'}</div>
        </div>
        <div class="transcription-section">
          <div class="label">Recorded:</div>
          <div class="text diff-text">${diffContent}</div>
        </div>
      </div>
    `;
    })
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Script Diff Report - ${escapeHtml(projectName)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; background: #f5f5f5; }
    h1 { color: #333; border-bottom: 2px solid #4ecdc4; padding-bottom: 0.5rem; }
    .summary { background: white; border-radius: 8px; padding: 1.5rem; margin-bottom: 2rem; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; }
    .summary-item { text-align: center; padding: 1rem; background: #f9f9f9; border-radius: 4px; }
    .summary-item .number { font-size: 2rem; font-weight: bold; color: #333; }
    .summary-item .label { font-size: 0.85rem; color: #666; }
    .summary-item.diff .number { color: #ff6b6b; }
    .summary-item.match .number { color: #4ecdc4; }
    .node { background: white; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .node.has-diff { border-left: 4px solid #ff6b6b; }
    .node.match { border-left: 4px solid #4ecdc4; }
    .node-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .audio-file { font-size: 0.85rem; color: #666; background: #f0f0f0; padding: 0.25rem 0.5rem; border-radius: 4px; }
    .status-badge { font-size: 0.75rem; font-weight: bold; padding: 0.25rem 0.5rem; border-radius: 4px; margin-left: auto; }
    .status-badge.diff { background: #ffe0e0; color: #c62828; }
    .status-badge.ok { background: #e0f7f5; color: #00796b; }
    .label { font-size: 0.85rem; font-weight: bold; color: #666; margin-bottom: 0.25rem; }
    .text { background: #f9f9f9; padding: 0.75rem; border-radius: 4px; line-height: 1.6; }
    .script-section, .transcription-section { margin-bottom: 1rem; }
    .added { background: #d4edda; color: #155724; padding: 0.1rem 0.2rem; border-radius: 2px; }
    .removed { background: #f8d7da; color: #721c24; text-decoration: line-through; padding: 0.1rem 0.2rem; border-radius: 2px; }
    .match { color: #155724; }
    .pending { color: #856404; }
    .failed { color: #721c24; }
    .no-transcription { color: #6c757d; }
    .legend { display: flex; gap: 1.5rem; margin-bottom: 2rem; flex-wrap: wrap; }
    .legend-item { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
    .legend-color { width: 20px; height: 20px; border-radius: 4px; }
    .legend-color.added { background: #d4edda; }
    .legend-color.removed { background: #f8d7da; }
  </style>
</head>
<body>
  <h1>Script Diff Report: ${escapeHtml(projectName)}</h1>

  <div class="summary">
    <h2>Summary</h2>
    <div class="summary-grid">
      <div class="summary-item"><div class="number">${summary.totalNodes}</div><div class="label">Total Nodes</div></div>
      <div class="summary-item diff"><div class="number">${summary.nodesWithDiff}</div><div class="label">With Differences</div></div>
      <div class="summary-item match"><div class="number">${summary.nodesMatching}</div><div class="label">Matching</div></div>
      <div class="summary-item"><div class="number">${summary.nodesPendingTranscription}</div><div class="label">Pending</div></div>
    </div>
  </div>

  <div class="legend">
    <div class="legend-item"><div class="legend-color added"></div> Added in recording</div>
    <div class="legend-item"><div class="legend-color removed"></div> Missing from recording</div>
  </div>

  <h2>Detailed Comparison</h2>
  ${diffHtml}
</body>
</html>`;
}

export function generateDiffTextReport(
  projectName: string,
  diffs: DiffNode[],
  summary: DiffSummary,
): string {
  const lines: string[] = [
    `SCRIPT DIFF REPORT: ${projectName}`,
    '='.repeat(50),
    '',
    'SUMMARY',
    '-'.repeat(30),
    `Total Nodes with Audio: ${summary.totalNodes}`,
    `Nodes with Differences: ${summary.nodesWithDiff}`,
    `Nodes Matching: ${summary.nodesMatching}`,
    `Pending Transcription: ${summary.nodesPendingTranscription}`,
    `Failed Transcription: ${summary.nodesFailedTranscription}`,
    '',
    '='.repeat(50),
    'DETAILED COMPARISON',
    '='.repeat(50),
    '',
  ];

  for (const d of diffs) {
    lines.push(`NODE: ${d.nodeId}`);
    lines.push(`Audio: ${d.audioFile || 'N/A'}`);
    lines.push(`Status: ${d.hasDiff ? 'DIFFERS' : 'OK'}`);
    lines.push('');
    lines.push('SCRIPT:');
    lines.push(d.scriptText || '(no script text)');
    lines.push('');
    lines.push('RECORDED:');
    lines.push(d.transcribedText || `(${d.transcriptionStatus})`);
    lines.push('');
    lines.push('-'.repeat(50));
    lines.push('');
  }

  return lines.join('\n');
}
