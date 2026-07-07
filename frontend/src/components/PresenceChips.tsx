// chip strip rendering the OTHER editors currently
// connected to this project. Lives in the workspace toolbar so
// every tab (Story, Graph, Audio, Theme, Build, Settings) shows the
// same presence — switching tabs doesn't disconnect from Y.Doc.

import type { PresentUser } from '../hooks/usePresence';

interface PresenceChipsProps {
  users: PresentUser[];
  /** Max chips to render inline before condensing into a "+N" badge. */
  max?: number;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? '?';
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function PresenceChips({ users, max = 4 }: PresenceChipsProps) {
  if (users.length === 0) return null;
  const visible = users.slice(0, max);
  const overflow = users.length - visible.length;
  return (
    <div
      className="presence-chips"
      data-testid="presence-chips"
      role="group"
      aria-label="Active editors"
    >
      {visible.map((u) => (
        <span
          key={u.clientId}
          className="presence-chip"
          style={{ backgroundColor: u.color }}
          title={u.displayName}
          data-testid="presence-chip"
        >
          {initials(u.displayName)}
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="presence-chip presence-chip-overflow"
          title={`${overflow} more editor${overflow === 1 ? '' : 's'}`}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
