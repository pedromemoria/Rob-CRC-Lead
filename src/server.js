import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './database.js';
import express from 'express';
import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { KnowledgeError } from './knowledge.js';
import { createClinics } from './clinics.js';
import { createAgent } from './agent.js';
import { createCrms } from './crm.js';
import { createWorker } from './worker.js';
import { webhooks } from './webhooks.js';
import { admin } from './admin.js';
import { createAccounts } from './accounts.js';
import { createSessions } from './admin-auth.js';
import { createFeedback } from './feedback.js';
import { createDocuments } from './documents.js';

export function createApp(config, store, clinics, services = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.get('/', (req, res) => res.redirect(303, '/admin/treinar'));
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/webhook', webhooks(config, store, clinics));
  app.use('/admin', admin(config, clinics, store, services));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
      return res.sendStatus(error.status);
    }
    if (error instanceof KnowledgeError) return res.status(422).type('text').send(error.message);
    console.error('Falha interna na requisição');
    res.sendStatus(500);
  });
  return app;
}

export async function start() {
  const config = loadConfig();
  const pool = createPool(config.database);
  let clinics;
  try {
    const { rows: [schema] } = await pool.query(
      "SELECT to_regclass('sdr.jobs') AS jobs, to_regclass('sdr.history') AS history," +
      " to_regclass('sdr.paused') AS paused, to_regclass('sdr.clinicas') AS clinicas, to_regclass('sdr.clinic_files') AS files," +
      " to_regclass('sdr.admin_sessions') AS sessions, to_regclass('sdr.clinic_feedback') AS feedback, " +
      " to_regclass('sdr.admin_accounts') AS accounts," +
      " (SELECT count(*) = 3 FROM information_schema.columns WHERE table_schema = 'sdr'" +
      " AND table_name IN ('jobs','paused','history') AND column_name = 'clinica_id') AS tenant_columns," +
      " EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'sdr'" +
      " AND table_name = 'clinicas' AND column_name = 'webhook_token_cifrado') AS webhook_column," +
      " EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'sdr'" +
            " AND table_name = 'clinicas' AND column_name = 'ativo') AS active_column," +
      " EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'sdr'" +
      " AND table_name = 'clinicas' AND column_name = 'dados_publicos') AS clinic_data_column," +
      " EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'sdr'" +
      " AND table_name = 'clinicas' AND column_name = 'crm_tipo' AND is_nullable = 'YES') AS draft_ready," +
      " EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('sdr.clinicas')" +
      " AND conname='clinicas_configuracao_crm_erp') AS erp_ready"
    );
    if (!Object.values(schema).every(Boolean)) {
      throw new Error('Execute supabase/schema.sql, supabase/multi-clinica.sql, supabase/painel-clinicas.sql, supabase/admin-saas.sql, supabase/contas-admin.sql, supabase/dados-clinicas.sql, supabase/cadastro-rapido.sql e supabase/agendamento-erp.sql no SQL Editor antes de iniciar.');
    }
    clinics = createClinics(pool, config, fileURLToPath(new URL('../knowledge/', import.meta.url)));
  } catch (error) {
    await pool.end();
    if (!error.code) throw error;
    throw new Error('Falha ao acessar o PostgreSQL. Confira DATABASE_URL, TLS e o schema (código ' + error.code + ').');
  }
  const store = createStore(pool);
  const documents = createDocuments(pool);
  const feedback = createFeedback(pool);
  const sessions = createSessions(pool);
  const accounts = createAccounts(pool);
  const decide = createAgent(config.openai);
  const worker = createWorker({
    store, documents, feedback, decide,
    integrationFor: clinics.integration, crmFor: createCrms
  });
  const server = createApp(config, store, clinics, { accounts, documents, feedback, sessions, decide }).listen(config.port, config.host, () => {
    worker.start();
    console.log('Agente SDR escutando na porta ' + config.port);
  });

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await Promise.all([
      new Promise(resolve => server.close(resolve)),
      worker.stop()
    ]);
    await pool.end();
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await start();
  } catch (error) {
    console.error('Falha ao iniciar. ' + (error instanceof TypeError ? 'Verifique as variáveis de ambiente.' : error.message));
    process.exitCode = 1;
  }
}
