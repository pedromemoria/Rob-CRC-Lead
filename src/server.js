import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './database.js';
import express from 'express';
import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { createKnowledge, KnowledgeError } from './knowledge.js';
import { createAgent } from './agent.js';
import { createCrms } from './crm.js';
import { createWorker } from './worker.js';
import { webhooks } from './webhooks.js';
import { admin } from './admin.js';

export function createApp(config, store, knowledge) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/webhooks', webhooks(config, store));
  app.use('/admin', admin(config, knowledge, store));
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
  let knowledge;
  try {
    const { rows: [schema] } = await pool.query(
      "SELECT to_regclass('sdr.jobs') AS jobs, to_regclass('sdr.history') AS history," +
      " to_regclass('sdr.paused') AS paused, to_regclass('sdr.knowledge') AS knowledge"
    );
    if (!Object.values(schema).every(Boolean)) {
      throw new Error('Execute supabase/schema.sql no SQL Editor antes de iniciar.');
    }
    knowledge = createKnowledge(fileURLToPath(new URL('../knowledge/', import.meta.url)), pool);
    await knowledge.load();
  } catch (error) {
    await pool.end();
    if (!error.code) throw error;
    throw new Error('Falha ao acessar o PostgreSQL. Confira DATABASE_URL, TLS e o schema (código ' + error.code + ').');
  }
  const store = createStore(pool);
  const worker = createWorker({
    store, decide: createAgent(config.openai, knowledge),
    crms: createCrms(config), bookingUrl: config.bookingUrl
  });
  const server = createApp(config, store, knowledge).listen(config.port, config.host, () => {
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
