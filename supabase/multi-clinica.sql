BEGIN;

CREATE SCHEMA IF NOT EXISTS sdr;
REVOKE ALL ON SCHEMA sdr FROM PUBLIC;

CREATE TABLE IF NOT EXISTS sdr.clinicas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome_clinica text NOT NULL CHECK (char_length(nome_clinica) BETWEEN 1 AND 120),
  crm_tipo text NOT NULL CHECK (crm_tipo IN ('kommo', 'ghl')),
  crm_token text NOT NULL,
  crm_account_id text NOT NULL,
  kommo_conta_id text UNIQUE,
  webhook_token_hash text,
  funil_id text NOT NULL,
  etapa_agendamento_id text NOT NULL,
  responsavel_id text NOT NULL,
  agendamento_url text NOT NULL,
  regras_negocio text NOT NULL CHECK (octet_length(regras_negocio) <= 24000),
  quebra_objecoes text NOT NULL CHECK (octet_length(quebra_objecoes) <= 24000),
  faq text NOT NULL CHECK (octet_length(faq) <= 24000),
  versao integer NOT NULL DEFAULT 1,
  UNIQUE (crm_tipo, crm_account_id),
  CHECK (
    (crm_tipo = 'kommo' AND kommo_conta_id IS NOT NULL AND webhook_token_hash IS NOT NULL)
    OR (crm_tipo = 'ghl' AND kommo_conta_id IS NULL AND webhook_token_hash IS NULL)
  )
);

ALTER TABLE sdr.clinicas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sdr.clinicas FROM PUBLIC;

-- Eventos anteriores à migração conservam o valor NULL e ficam fora da fila multi-clínica.
ALTER TABLE sdr.jobs ADD COLUMN IF NOT EXISTS clinica_id uuid REFERENCES sdr.clinicas(id);
ALTER TABLE sdr.paused ADD COLUMN IF NOT EXISTS clinica_id uuid REFERENCES sdr.clinicas(id);
ALTER TABLE sdr.history ADD COLUMN IF NOT EXISTS clinica_id uuid REFERENCES sdr.clinicas(id);
CREATE INDEX IF NOT EXISTS paused_clinica_since ON sdr.paused (clinica_id, since DESC);

CREATE INDEX IF NOT EXISTS jobs_clinica_operacao
  ON sdr.jobs (clinica_id, seq) WHERE state IN ('blocked', 'uncertain');

COMMIT;
