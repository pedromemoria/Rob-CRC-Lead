BEGIN;

ALTER TABLE sdr.clinicas
  ADD COLUMN IF NOT EXISTS dados_publicos jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(dados_publicos) = 'object' AND octet_length(dados_publicos::text) <= 80000);

COMMIT;
