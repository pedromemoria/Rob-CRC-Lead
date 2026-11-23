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

  async function processJob(store, job) {
    const crm = crms[job.event.provider];
    if (!job.plan) {
      if (await store.paused(job.lead)) return store.finish(job);
      const decision = await decide(job.event, await store.history(job));
      if (decision.kind === 'transbordo_humano') await store.plan(job, decision, 'handoff');
      else if (decision.kind === 'qualificar_agendamento') await store.plan(job, decision, 'qualify');
      else {
        if (!safeReply(decision.text)) throw new KnowledgeError('Resposta inválida');
        await store.plan(job, decision, 'send');
      }
    }
    if (job.step === 'qualify') {
      try {
        await crm.qualify(job.event);
        await store.plan(job, job.plan, 'send');
      } catch (error) {
        if (!(error instanceof OpportunityError)) throw error;
        await store.plan(job, { kind: 'transbordo_humano', reason: 'oportunidade' }, 'handoff');
      }
    }
    if (job.step === 'handoff') {
      await store.startEffect(job);
      await crm.handoff(job.event, handoffReasons[job.plan.reason], job.id.slice(0, 16));
      return store.finish(job);
    }
    if (job.step !== 'send') throw new Error('Etapa inválida');
    const text = job.plan.kind === 'qualificar_agendamento'
      ? 'Perfeito! Escolha o melhor horário por aqui:\n' + bookingUrl
      : job.plan.text;
    if (job.plan.kind === 'responder' && !safeReply(text)) throw new KnowledgeError('Resposta inválida');
    await store.startEffect(job);
    await crm.send(job.event, text);
    await store.finish(job, text);
  }

  async function processNext(store) {
    if (Date.now() >= nextPrune) {
      await store.pruneHistory();
      nextPrune = Date.now() + 3_600_000;
    }
    const job = await store.claim();
    if (!job) return;
    try {
      await processJob(store, job);
    } catch (error) {
      const status = errorStatus(error);
      const code = status ? 'HTTP ' + status : (error instanceof KnowledgeError ? 'knowledge' : 'internal_or_network');
      const transient = !status || [408, 425, 429].includes(status) || status >= 500;
      let state = 'blocked';
      if (job.effect && (!status || status === 408 || status >= 500)) state = 'uncertain';
      else if (!(error instanceof KnowledgeError) && transient && job.attempts < 4) state = 'queued';
      await store.fail(job, state, code, state === 'queued' ? 2000 * 2 ** job.attempts : 0);
      logger.error('Falha no processamento', { job: job.seq, step: job.step ?? 'decide', state, code });
    }
  }

  const tick = () => store.withWorker(processNext);

  return {
    tick,
    start() {
      timer = setInterval(() => {
        if (active) return;
        active = tick().catch(() => logger.error('Falha no acesso à fila')).finally(() => { active = null; });
      }, 1000);
    },
    async stop() {
      clearInterval(timer);
      await active;
    }
  };
}
