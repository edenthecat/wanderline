// Stable `id` attributes for the panels the Ship tab's readiness
// summary links into.
//
// Its own module, with no imports, so a panel can claim its anchor
// without depending on the summary that points at it — and so the
// anchor and the link that uses it can never drift apart. Each is
// rendered at most once per page, which is what makes a fixed id
// (rather than a query for a class) safe.

export const PANEL_ANCHORS = {
  /** ValidationPanel — parser errors and warnings, Story tab. */
  validation: 'panel-validation',
  /** FlaggedNodesPanel — human-reported issues, Story tab. */
  flaggedNodes: 'panel-flagged-nodes',
  /** StoryHealthPanel — unreachable passages and dead ends, Story tab. */
  storyHealth: 'panel-story-health',
  /** AudioTab's "Nodes without voiceover" list. */
  missingVoiceover: 'panel-missing-voiceover',
  /** AssignmentAuditPanel — clips disagreeing with their filename. */
  assignmentAudit: 'panel-assignment-audit',
} as const;
