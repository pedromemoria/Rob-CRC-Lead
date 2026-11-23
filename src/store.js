import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const encode = JSON.stringify;
export const leadKey = event => [event.provider, event.account, event.leadId].join(':');
const eventKey = event => createHash('sha256')
  .update([event.provider, event.account, event.eventId].join(':')).digest('hex');

export function createStore(file) {
  const db = new DatabaseSync(file, { timeout: 1000 });
  db.exec(
    'PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;' +
    "CREATE TABLE IF NOT EXISTS jobs (" +
    " seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, lead TEXT NOT NULL," +
    " event TEXT, plan TEXT, state TEXT NOT NULL DEFAULT 'queued', step TEXT," +
    " effect INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0," +
    " due INTEGER NOT NULL DEFAULT 0, error TEXT);" +
    "CREATE INDEX IF NOT EXISTS jobs_lead_state ON jobs(lead,state,seq);" +
    "CREATE TABLE IF NOT EXISTS paused (lead TEXT PRIMARY KEY, since INTEGER NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS history (" +
    " seq INTEGER PRIMARY KEY, lead TEXT NOT NULL, conversation TEXT NOT NULL," +
    " inbound TEXT NOT NULL, outbound TEXT NOT NULL, offered INTEGER NOT NULL, inserted INTEGER NOT NULL);" +
    "CREATE INDEX IF NOT EXISTS history_lookup ON history(lead,conversation,seq);"
  );

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const updatePlan = db.prepare('UPDATE jobs SET plan = ?, step = ?, effect = 0 WHERE seq = ?');
  const clear = db.prepare("UPDATE jobs SET state = 'done', event = NULL, plan = NULL, effect = 0, error = NULL WHERE seq = ?");

  return {
    recover() {
      // Uma instância por banco. Operações remotas sem idempotência exigem conciliação.
      db.exec("UPDATE jobs SET state = 'uncertain', error = 'interrupted' WHERE state = 'running' AND effect = 1;" +
        "UPDATE jobs SET state = 'queued' WHERE state = 'running';");
    },
    enqueue(events) {
      if (!events.length) return;
      const insert = db.prepare('INSERT OR IGNORE INTO jobs(id,lead,event) VALUES(?,?,?)');
      transaction(() => {
        for (const event of events) insert.run(eventKey(event), leadKey(event), encode(event));
      });
    },
    claim(now = Date.now()) {
      return transaction(() => {
        const job = db.prepare(
          "SELECT * FROM jobs AS j WHERE j.state = 'queued' AND j.due <= ? AND NOT EXISTS (" +
          " SELECT 1 FROM jobs AS prior WHERE prior.lead = j.lead AND prior.seq < j.seq AND prior.state != 'done'" +
          ') ORDER BY j.seq LIMIT 1'
        ).get(now);
        if (!job) return null;
        db.prepare("UPDATE jobs SET state = 'running' WHERE seq = ?").run(job.seq);
        return { ...job, event: JSON.parse(job.event), plan: JSON.parse(job.plan) };
      });
    },
    plan(job, plan, step) {
      transaction(() => {
        updatePlan.run(encode(plan), step, job.seq);
        if (plan.kind === 'transbordo_humano') {
          db.prepare('INSERT OR IGNORE INTO paused(lead,since) VALUES(?,?)').run(job.lead, Date.now());
        }
      });
      job.plan = plan;
      job.step = step;
      job.effect = 0;
    },
    paused(lead) {
      return Boolean(db.prepare('SELECT 1 FROM paused WHERE lead = ?').get(lead));
    },
    history(job) {
      return db.prepare(
        'SELECT inbound,outbound,offered FROM history WHERE lead = ? AND conversation = ?' +
        ' AND inserted >= ? ORDER BY seq DESC LIMIT 12'
      ).all(job.lead, job.event.conversationId, Date.now() - 30 * 86_400_000).reverse();
    },
    startEffect(job) {
      db.prepare('UPDATE jobs SET effect = 1 WHERE seq = ?').run(job.seq);
      job.effect = 1;
    },
    finish(job, outbound) {
      transaction(() => {
        if (outbound) {
          db.prepare('INSERT INTO history VALUES(?,?,?,?,?,?,?)')
            .run(job.seq, job.lead, job.event.conversationId, job.event.text, outbound,
              Number(Boolean(job.plan?.offer)), Date.now());
          db.prepare('DELETE FROM history WHERE lead = ? AND conversation = ? AND seq NOT IN (' +
            ' SELECT seq FROM history WHERE lead = ? AND conversation = ? ORDER BY seq DESC LIMIT 12' +
            ')').run(job.lead, job.event.conversationId, job.lead, job.event.conversationId);
        }
        clear.run(job.seq);
      });
    },
    fail(job, state, error, delay = 0) {
      db.prepare('UPDATE jobs SET state = ?, error = ?, due = ?, attempts = attempts + 1, effect = ? WHERE seq = ?')
        .run(state, error, Date.now() + delay, state === 'uncertain' ? 1 : 0, job.seq);
    },
    pending() {
      return db.prepare("SELECT seq,lead,state,step,error,substr(id,1,16) AS reference FROM jobs " +
        "WHERE state IN ('blocked','uncertain') ORDER BY seq LIMIT 100").all();
    },
    resolve(seq, action) {
      const job = db.prepare("SELECT seq,state FROM jobs WHERE seq = ? AND state IN ('blocked','uncertain')").get(seq);
      if (!job) return false;
      if (action === 'descartar') clear.run(seq);
      else if (action === 'tentar') {
        db.prepare("UPDATE jobs SET state = 'queued', due = 0, effect = 0, attempts = 0, error = NULL WHERE seq = ?").run(seq);
      } else return false;
      return true;
    },
    pausedLeads() {
      return db.prepare('SELECT lead FROM paused ORDER BY since DESC LIMIT 100').all();
    },
    resume(lead) {
      return transaction(() => {
        if (!db.prepare('SELECT 1 FROM paused WHERE lead = ?').get(lead)) return false;
        if (db.prepare("SELECT 1 FROM jobs WHERE lead = ? AND step = 'handoff' AND state != 'done'").get(lead)) return false;
        // Ignora o backlog acumulado durante o atendimento humano.
        db.prepare("UPDATE jobs SET state = 'done', event = NULL, plan = NULL, effect = 0, error = NULL" +
          " WHERE lead = ? AND state = 'queued'").run(lead);
        db.prepare('DELETE FROM history WHERE lead = ?').run(lead);
        return db.prepare('DELETE FROM paused WHERE lead = ?').run(lead).changes > 0;
      });
    },
    pruneHistory() {
      db.prepare('DELETE FROM history WHERE inserted < ?').run(Date.now() - 30 * 86_400_000);
    },
    close: () => db.close()
  };
}
