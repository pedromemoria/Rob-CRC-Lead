BEGIN;

ALTER TABLE sdr.clinicas DROP CONSTRAINT IF EXISTS clinicas_configuracao_crm;
ALTER TABLE sdr.clinicas DROP CONSTRAINT IF EXISTS clinicas_configuracao_crm_erp;
ALTER TABLE sdr.clinicas ADD CONSTRAINT clinicas_configuracao_crm_erp CHECK (
  (crm_tipo IS NULL AND crm_token IS NULL AND crm_account_id IS NULL AND kommo_conta_id IS NULL
    AND webhook_token_hash IS NULL AND webhook_token_cifrado IS NULL
    AND funil_id IS NULL AND etapa_agendamento_id IS NULL AND responsavel_id IS NULL AND NOT ativo)
  OR
  (crm_tipo IS NOT NULL AND crm_token IS NOT NULL AND crm_account_id IS NOT NULL
    AND funil_id IS NOT NULL AND etapa_agendamento_id IS NOT NULL AND responsavel_id IS NOT NULL)
);

COMMIT;
