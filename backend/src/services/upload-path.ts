import { resolve, sep } from 'path';
import { UPLOAD_DIR } from '../config.js';

/**
 * The local path of an uploaded file, refusing anything that would land
 * outside the uploads directory. Project ids are validated as UUIDs and
 * stored filenames are generated server-side, so this should never trip;
 * it makes the containment explicit rather than implied by those checks.
 */
export function uploadPath(projectId: string, filename: string): string {
  const root = resolve(UPLOAD_DIR);
  const path = resolve(root, projectId, filename);
  if (!path.startsWith(root + sep)) {
    throw new Error('Refusing an upload path outside the uploads directory');
  }
  return path;
}
