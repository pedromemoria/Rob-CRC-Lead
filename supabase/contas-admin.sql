BEGIN;

CREATE TABLE IF NOT EXISTS sdr.admin_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  clinica_id uuid REFERENCES sdr.clinicas(id),
  password_hash text,
  invitation_hash text UNIQUE,
  invitation_expires timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sdr.admin_sessions
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES sdr.admin_accounts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS admin_sessions_account_idx ON sdr.admin_sessions(account_id);
ALTER TABLE sdr.admin_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sdr.admin_accounts FROM PUBLIC;

COMMIT;
