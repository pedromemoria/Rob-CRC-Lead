import { ClinicError } from './clinics.js';
import { OpportunityError } from './crm.js';
import { handoffReasons } from './agent.js';
import { KnowledgeError, safeReply } from './knowledge.js';

function errorStatus(error) {
  const status = error?.status ?? error?.response?.status;
  return Number.isInteger(status) ? status : 0;
}

export function createWorker({ store, decide, integrationFor, crmFor, documents, feedback, logger = console }) {
  let timer;
  let active;
  let nextPrune = 0;

  async function processJob(store, job) {
    if (!job.plan && await store.paused(job.clinica_id, job.lead)) return store.finish(job);
    const integration = await integrationFor(job.clinica_id);
    if (integration.provider !== job.event.provider) throw new ClinicError('O CRM do evento não corresponde à clínica.');
    const crm = crmFor(integration)[job.event.provider];
    if (!job.plan) {
      const history = await store.history(job);
      const search = [job.event.text, history.at(-1)?.inbound].filter(Boolean).join(' ');
      const [references, corrections] = await Promise.all([
        documents?.context(job.clinica_id, search) ?? [], feedback?.list(job.clinica_id) ?? []
      ]);
      const decision = await decide(job.event, history, {
        ...integration.knowledge, references, feedback: corrections.map(row => row.conteudo)
      });
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
      ? 'Perfeito! Escolha o melhor horário por aqui:\n' + integration.bookingUrl
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
      const configurationError = error instanceof ClinicError || error instanceof KnowledgeError;
      const code = status ? 'HTTP ' + status : (configurationError ? 'clinic_configuration' : 'internal_or_network');
      const transient = !status || [408, 425, 429].includes(status) || status >= 500;
      let state = 'blocked';
      if (job.effect && (!status || status === 408 || status >= 500)) state = 'uncertain';
      else if (!configurationError && transient && job.attempts < 4) state = 'queued';
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
