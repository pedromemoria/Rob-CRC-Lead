BEGIN;
ALTER TABLE sdr.clinicas ADD COLUMN IF NOT EXISTS agenda_autonoma jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sdr.history ADD COLUMN IF NOT EXISTS agenda_ofertada jsonb;
COMMIT;
