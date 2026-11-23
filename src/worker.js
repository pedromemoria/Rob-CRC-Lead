import { OpportunityError } from './crm.js';
import { handoffReasons } from './agent.js';
import { KnowledgeError, safeReply } from './knowledge.js';

function errorStatus(error) {
  const status = error?.status ?? error?.response?.status;
  return Number.isInteger(status) ? status : 0;
}

export function createWorker({ store, decide, crms, bookingUrl, logger = console }) {
  let timer;
  let active;
  let nextPrune = 0;

  async function processJob(job) {
    const crm = crms[job.event.provider];
    if (!job.plan) {
      if (store.paused(job.lead)) return store.finish(job);
      const decision = await decide(job.event, store.history(job));
      if (decision.kind === 'transbordo_humano') store.plan(job, decision, 'handoff');
      else if (decision.kind === 'qualificar_agendamento') store.plan(job, decision, 'qualify');
      else {
        if (!safeReply(decision.text)) throw new KnowledgeError('Resposta inválida');
        store.plan(job, decision, 'send');
      }
    }
    if (job.step === 'qualify') {
      try {
        await crm.qualify(job.event);
        store.plan(job, job.plan, 'send');
      } catch (error) {
        if (!(error instanceof OpportunityError)) throw error;
        store.plan(job, { kind: 'transbordo_humano', reason: 'oportunidade' }, 'handoff');
      }
    }
    if (job.step === 'handoff') {
      store.startEffect(job);
      await crm.handoff(job.event, handoffReasons[job.plan.reason], job.id.slice(0, 16));
      return store.finish(job);
    }
    if (job.step !== 'send') throw new Error('Etapa inválida');
    const text = job.plan.kind === 'qualificar_agendamento'
      ? 'Perfeito! Escolha o melhor horário por aqui:\n' + bookingUrl
      : job.plan.text;
    if (job.plan.kind === 'responder' && !safeReply(text)) throw new KnowledgeError('Resposta inválida');
    store.startEffect(job);
    await crm.send(job.event, text);
    store.finish(job, text);
  }

  async function tick() {
    if (Date.now() >= nextPrune) {
      store.pruneHistory();
      nextPrune = Date.now() + 3_600_000;
    }
    const job = store.claim();
    if (!job) return;
    try {
      await processJob(job);
    } catch (error) {
      const status = errorStatus(error);
      const code = status ? 'HTTP ' + status : (error instanceof KnowledgeError ? 'knowledge' : 'internal_or_network');
      const transient = !status || [408, 425, 429].includes(status) || status >= 500;
      let state = 'blocked';
      if (job.effect && (!status || status === 408 || status >= 500)) state = 'uncertain';
      else if (!(error instanceof KnowledgeError) && transient && job.attempts < 4) state = 'queued';
      store.fail(job, state, code, state === 'queued' ? 2000 * 2 ** job.attempts : 0);
      logger.error('Falha no processamento', { job: job.seq, step: job.step ?? 'decide', state, code });
    }
  }

  return {
    tick,
    start() {
      timer = setInterval(() => {
        if (active) return;
        active = tick().catch(() => logger.error('Falha no acesso à fila')).finally(() => { active = null; });
      }, 250);
    },
    async stop() {
      clearInterval(timer);
      await active;
    }
  };
}
