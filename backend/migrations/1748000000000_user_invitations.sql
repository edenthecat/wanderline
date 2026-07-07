-- user_invitations
--
-- Stores pending magic-link invitations. The admin generates an
-- invitation row; the raw URL-safe token is shown to them once (in the
-- POST response) and only its SHA-256 hash is persisted here, so a
-- read of the DB can't be used to consume an outstanding invitation.
--
-- The role values mirror users.role's CHECK constraint ('admin',
-- 'editor') so that on acceptance the new users row can be inserted
-- with the same value verbatim.

-- Up Migration

CREATE TABLE IF NOT EXISTS user_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'editor')),
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  accepted_at TIMESTAMP WITH TIME ZONE,
  accepted_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_invitations_email ON user_invitations(email);
CREATE INDEX IF NOT EXISTS idx_user_invitations_expires_at ON user_invitations(expires_at);

-- Down Migration

-- DROP TABLE IF EXISTS user_invitations;
