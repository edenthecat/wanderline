// Shows which Wanderline build the backend is actually running.
//
// Exists because of a real incident: the instance repo recorded
// IMAGE_TAG=1.0.2 while production had been hand-deployed to 1.4.0,
// and nothing in the product surfaced the difference. Establishing the
// truth meant diffing the live API surface against a local checkout.
// The version is cheap to report, so report it.
//
// Renders nothing at all if the endpoint fails. A version badge is
// diagnostic garnish — it must never turn a backend hiccup into a
// visible error in the editor chrome.

import { useEffect, useState } from 'react';
import { fetchAppVersion, type AppVersion } from '../api/client';

export default function VersionBadge() {
  const [info, setInfo] = useState<AppVersion | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAppVersion()
      .then((v) => {
        if (!cancelled) setInfo(v);
      })
      .catch(() => {
        // Deliberately silent — see the note above.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!info) return null;

  // The commit is what actually distinguishes two deploys of the same
  // semver, which is the case that caused the confusion, so it goes in
  // the tooltip rather than being dropped.
  const title = [
    `Wanderline ${info.version}`,
    info.commit ? `commit ${info.commit}` : null,
    `environment ${info.environment}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <span className="version-badge" title={title} aria-label={title}>
      v{info.version}
      {/* Non-production deploys are worth calling out inline: mistaking
          a staging tab for production is its own class of incident. */}
      {info.environment !== 'production' && (
        <span className="version-badge-env"> {info.environment}</span>
      )}
    </span>
  );
}
