// Assignments whose filename disagrees with the node they sit on.
//
// /rematch skips any file that already has an assignment, so a project
// populated under older matching logic never gets re-examined. That was
// fine while the matcher only gained precision, but a matcher BUG
// leaves silently wrong assignments that nothing revisits — which is
// what happened with ink stitch names sharing a bare name across knots.
//
// Deliberately read-only. A filename that disagrees with its node is
// often intentional (an author assigned a clip by hand), so this
// produces a list to review rather than a correction to trust.

import { useState } from 'react';
import {
  acknowledgeAssignment,
  auditAudioAssignments,
  type AssignmentDisagreement,
} from '../api/client';

interface Props {
  projectId: string;
}

export default function AssignmentAuditPanel({ projectId }: Props) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    totalAssignments: number;
    acknowledged: number;
    disagreements: AssignmentDisagreement[];
  } | null>(null);
  const [acking, setAcking] = useState<string | null>(null);

  const rowKey = (d: AssignmentDisagreement) =>
    `${d.audioFileId}:${d.currentNodeId}:${d.currentAudioType}`;

  // Drops the row locally rather than refetching: the author is working
  // down a list, and having it reorder under them on every click makes
  // it easy to lose their place.
  async function markFine(d: AssignmentDisagreement) {
    setAcking(rowKey(d));
    setError(null);
    try {
      await acknowledgeAssignment(projectId, {
        audioFileId: d.audioFileId,
        nodeId: d.currentNodeId,
        audioType: d.currentAudioType,
      });
      setResult((prev) =>
        prev
          ? {
              ...prev,
              acknowledged: prev.acknowledged + 1,
              disagreements: prev.disagreements.filter((x) => rowKey(x) !== rowKey(d)),
            }
          : prev,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not mark as fine');
    } finally {
      setAcking(null);
    }
  }

  async function run() {
    setRunning(true);
    setError(null);
    try {
      setResult(await auditAudioAssignments(projectId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="settings-section">
      <h2>Check audio assignments</h2>
      <p className="text-muted">
        Re-runs the filename matcher over every clip that&rsquo;s already attached and lists any
        whose name now points somewhere else. Nothing is changed &mdash; reassign from the node or
        audio list once you&rsquo;ve confirmed.
      </p>
      <div className="settings-row">
        <button type="button" onClick={() => void run()} disabled={running}>
          {running ? 'Checking…' : 'Check assignments'}
        </button>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {result && result.disagreements.length === 0 && (
        <p className="text-muted" role="status">
          Checked {result.totalAssignments} assignment{result.totalAssignments === 1 ? '' : 's'} —
          nothing left to review
          {result.acknowledged > 0 && <> ({result.acknowledged} marked as fine)</>}.
        </p>
      )}

      {result && result.disagreements.length > 0 && (
        <>
          <p role="status">
            <strong>{result.disagreements.length}</strong> of {result.totalAssignments} assignments
            disagree with their filename
            {result.acknowledged > 0 && <> ({result.acknowledged} already marked as fine)</>}.
          </p>
          <div className="table-scroll">
            <table className="audit-table">
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Currently on</th>
                  <th scope="col">Filename suggests</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.disagreements.map((d) => (
                  <tr key={`${d.audioFileId}:${d.currentNodeId}:${d.currentAudioType}`}>
                    <td>{d.filename}</td>
                    <td>
                      <code>{d.currentNodeId}</code>
                      <span className="text-muted text-sm"> · {d.currentAudioType}</span>
                      {/* The strongest signal in the report: an
                          assignment to a passage the story no longer
                          has cannot be correct. */}
                      {!d.currentNodeExists && (
                        <span className="badge badge-red"> node missing</span>
                      )}
                    </td>
                    <td>
                      <code>{d.suggestedNodeId}</code>
                      {d.suggestedAudioType !== d.currentAudioType && (
                        <span className="text-muted text-sm"> · {d.suggestedAudioType}</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={acking === rowKey(d)}
                        onClick={() => void markFine(d)}
                        aria-label={`Mark ${d.filename} on ${d.currentNodeId} as fine`}
                      >
                        {acking === rowKey(d) ? 'Saving…' : 'Mark as fine'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
