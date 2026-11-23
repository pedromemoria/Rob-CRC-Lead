import { createHash } from 'node:crypto';
import { transaction } from './database.js';

export const leadKey = event => [event.provider, event.account, event.leadId].join(':');
const eventKey = event => createHash('sha256')
  .update([event.provider, event.account, event.eventId].join(':')).digest('hex');
const workerLock = 713901482;

const clear = "UPDATE sdr.jobs SET state = 'done', event = NULL, plan = NULL, effect = false, error = NULL";

export function createStore(database) {
  return {
    async withWorker(process) {
      const client = await database.connect();
      let healthy = true;
      const onError = () => { healthy = false; };
      client.on('error', onError);
      try {
        const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock($1) AS taken', [workerLock]);
        if (!lock.taken) return;
        try {
          const store = createStore(client);
          await store.recover();
          await process(store);
        } finally {
          if (healthy) await client.query('SELECT pg_advisory_unlock($1)', [workerLock]);
        }
      } catch (error) {
        healthy = false;
        throw error;
      } finally {
        client.removeListener('error', onError);
        client.release(!healthy);
      }
    },
    async recover() {
      // Effects marked before external calls require reconciliation after interruption.
      await database.query(
        "UPDATE sdr.jobs SET state = CASE WHEN effect THEN 'uncertain' ELSE 'queued' END," +
        " error = CASE WHEN effect THEN 'interrupted' ELSE error END WHERE state = 'running'"
      );
    },
    async enqueue(events) {
      if (!events.length) return;
      await database.query(
        'INSERT INTO sdr.jobs(id,lead,event) SELECT id,lead,event ' +
        'FROM jsonb_to_recordset($1::jsonb) AS incoming(id text,lead text,event jsonb) ON CONFLICT (id) DO NOTHING',
        [JSON.stringify(events.map(event => ({ id: eventKey(event), lead: leadKey(event), event })))]
      );
    },
    async claim() {
      const { rows } = await database.query(
        "UPDATE sdr.jobs SET state = 'running' WHERE seq = (" +
        " SELECT j.seq FROM sdr.jobs AS j WHERE j.state = 'queued' AND j.due <= now() AND NOT EXISTS (" +
        " SELECT 1 FROM sdr.jobs AS prior WHERE prior.lead = j.lead AND prior.seq < j.seq AND prior.state <> 'done'" +
        ') ORDER BY j.seq LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *'
      );
      return rows[0] ?? null;
    },
    async plan(job, plan, step) {
      await transaction(database, async client => {
        await client.query('UPDATE sdr.jobs SET plan = $1, step = $2, effect = false WHERE seq = $3',
          [plan, step, job.seq]);
        if (plan.kind === 'transbordo_humano') {
          await client.query('INSERT INTO sdr.paused(lead) VALUES($1) ON CONFLICT DO NOTHING', [job.lead]);
        }
      });
      Object.assign(job, { plan, step, effect: false });
    },
    async paused(lead) {
      const result = await database.query('SELECT 1 FROM sdr.paused WHERE lead = $1', [lead]);
      return result.rowCount > 0;
    },
    async history(job) {
      const { rows } = await database.query(
        'SELECT inbound,outbound,offered FROM sdr.history WHERE lead = $1 AND conversation = $2' +
        " AND inserted >= now() - interval '30 days' ORDER BY seq DESC LIMIT 12",
        [job.lead, job.event.conversationId]
      );
      return rows.reverse();
    },
    async startEffect(job) {
      await database.query('UPDATE sdr.jobs SET effect = true WHERE seq = $1', [job.seq]);
      job.effect = true;
    },
    async finish(job, outbound) {
      await transaction(database, async client => {
        if (outbound) {
          const conversation = job.event.conversationId;
          await client.query(
            'INSERT INTO sdr.history(seq,lead,conversation,inbound,outbound,offered) VALUES($1,$2,$3,$4,$5,$6)',
            [job.seq, job.lead, conversation, job.event.text, outbound, Boolean(job.plan?.offer)]
          );
          await client.query(
            'DELETE FROM sdr.history WHERE lead = $1 AND conversation = $2 AND seq NOT IN (' +
            ' SELECT seq FROM sdr.history WHERE lead = $1 AND conversation = $2 ORDER BY seq DESC LIMIT 12)',
            [job.lead, conversation]
          );
        }
        await client.query(clear + ' WHERE seq = $1', [job.seq]);
      });
    },
    async fail(job, state, error, delay = 0) {
      await database.query(
        'UPDATE sdr.jobs SET state = $1, error = $2, due = now() + $3::int * interval \'1 millisecond\',' +
        " attempts = attempts + 1, effect = $4 WHERE seq = $5 AND state = 'running'",
        [state, error, delay, state === 'uncertain', job.seq]
      );
    },
    async pending() {
      const { rows } = await database.query(
        "SELECT seq,lead,state,step,error,substr(id,1,16) AS reference FROM sdr.jobs " +
        "WHERE state IN ('blocked','uncertain') ORDER BY seq LIMIT 100"
      );
      return rows;
    },
    async resolve(seq, action) {
      const condition = " WHERE seq = $1 AND state IN ('blocked','uncertain')";
      if (action === 'descartar') return (await database.query(clear + condition, [seq])).rowCount > 0;
      if (action === 'tentar') {
        const result = await database.query(
          "UPDATE sdr.jobs SET state = 'queued', due = now(), effect = false, attempts = 0, error = NULL" + condition,
          [seq]
        );
        return result.rowCount > 0;
      }
      return false;
    },
    async pausedLeads() {
      const { rows } = await database.query('SELECT lead FROM sdr.paused ORDER BY since DESC LIMIT 100');
      return rows;
    },
    async resume(lead) {
      return transaction(database, async client => {
        const { rows: [lock] } = await client.query('SELECT pg_try_advisory_xact_lock($1) AS taken', [workerLock]);
        if (!lock.taken) return false;
        const paused = await client.query('SELECT 1 FROM sdr.paused WHERE lead = $1', [lead]);
        if (!paused.rowCount) return false;
        const pending = await client.query(
          "SELECT 1 FROM sdr.jobs WHERE lead = $1 AND step = 'handoff' AND state <> 'done' LIMIT 1", [lead]
        );
        if (pending.rowCount) return false;
        await client.query(clear + " WHERE lead = $1 AND state = 'queued'", [lead]);
        await client.query('DELETE FROM sdr.history WHERE lead = $1', [lead]);
        await client.query('DELETE FROM sdr.paused WHERE lead = $1', [lead]);
        return true;
      });
    },
    async pruneHistory() {
      await database.query("DELETE FROM sdr.history WHERE inserted < now() - interval '30 days'");
    }
  };
}
