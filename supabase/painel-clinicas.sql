BEGIN;

ALTER TABLE sdr.clinicas ADD COLUMN IF NOT EXISTS webhook_token_cifrado text;

CREATE TABLE IF NOT EXISTS sdr.clinic_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinica_id uuid NOT NULL REFERENCES sdr.clinicas(id),
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 180),
  formato text NOT NULL CHECK (formato IN ('pdf', 'docx', 'txt', 'csv')),
  conteudo text NOT NULL CHECK (octet_length(conteudo) BETWEEN 1 AND 160000),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  enviado_em timestamptz NOT NULL DEFAULT now(),
  busca tsvector GENERATED ALWAYS AS (to_tsvector('portuguese'::regconfig, conteudo)) STORED,
  UNIQUE (clinica_id, sha256)
);
CREATE INDEX IF NOT EXISTS clinic_files_by_clinica_date
  ON sdr.clinic_files(clinica_id, enviado_em DESC);
ALTER TABLE sdr.clinic_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sdr.clinic_files FROM PUBLIC;

COMMIT;
