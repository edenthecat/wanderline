// Shared credential-validation helpers. Setup, users, and
// invitations all need the same "is this a valid email + password +
// display name payload from an untrusted client" gate; keeping the
// rules in three near-identical copies drifted subtly during the
// last audit (invitations.ts had a distinct password error message,
// users.ts didn't cap display name length). One source of truth so
// changes propagate.

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_DISPLAY_NAME_LENGTH = 255;
/** bcrypt work factor. */
export const BCRYPT_ROUNDS = 12;

/**
 * Validate that a password is a string of the right length. Returns
 * the error message the caller should send back with HTTP 400, or
 * null if the password passes.
 *
 * The pre-consolidation routes (users PATCH, invitations accept)
 * returned the same "between MIN and MAX characters" message for
 * non-string inputs too, so we keep that behaviour to avoid a
 * user-visible API change.
 */
export function validatePassword(password: unknown): string | null {
  if (
    typeof password !== 'string' ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`;
  }
  return null;
}

export interface CredentialsPayload {
  email: string;
  password: string;
  displayName: string;
}

export interface CredentialsValidationOk {
  ok: true;
  email: string;
  password: string;
  displayName: string;
}

export interface CredentialsValidationError {
  ok: false;
  error: string;
}

/**
 * Validate a full `{ email, password, displayName }` payload for the
 * user-create-and-log-in flows (setup, users POST, invitation
 * accept). Returns either an { ok: true, ... } with the trimmed
 * values or an { ok: false, error } — the caller writes `error` to
 * a 400 response.
 *
 * Email is lower-cased and trimmed on success so downstream inserts
 * hit the same canonicalization on every path.
 */
export function validateCredentials(
  payload: unknown,
): CredentialsValidationOk | CredentialsValidationError {
  // Guard against null / undefined / non-object bodies — a router
  // catch-all can hand us anything the client posts.
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'Email, password, and display name must be strings' };
  }
  const { email, password, displayName } = payload as {
    email?: unknown;
    password?: unknown;
    displayName?: unknown;
  };
  if (
    typeof email !== 'string' ||
    typeof password !== 'string' ||
    typeof displayName !== 'string'
  ) {
    return { ok: false, error: 'Email, password, and display name must be strings' };
  }
  const trimmedEmail = email.trim();
  const trimmedName = displayName.trim();
  if (!trimmedEmail || !password || !trimmedName) {
    return { ok: false, error: 'Email, password, and display name are required' };
  }
  if (trimmedName.length > MAX_DISPLAY_NAME_LENGTH) {
    return {
      ok: false,
      error: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
    };
  }
  const passwordError = validatePassword(password);
  if (passwordError) {
    return { ok: false, error: passwordError };
  }
  return { ok: true, email: trimmedEmail.toLowerCase(), password, displayName: trimmedName };
}
