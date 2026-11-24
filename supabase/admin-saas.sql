BEGIN;

ALTER TABLE sdr.clinicas ADD COLUMN IF NOT EXISTS ativo boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS sdr.admin_sessions (
  token_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS admin_sessions_expires_idx ON sdr.admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS sdr.clinic_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinica_id uuid NOT NULL REFERENCES sdr.clinicas(id) ON DELETE CASCADE,
  slot integer NOT NULL CHECK (slot BETWEEN 1 AND 16),
  conteudo text NOT NULL CHECK (octet_length(conteudo) BETWEEN 1 AND 1600),
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinica_id, slot)
);

ALTER TABLE sdr.admin_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdr.clinic_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sdr.admin_sessions, sdr.clinic_feedback FROM PUBLIC;

COMMIT;
