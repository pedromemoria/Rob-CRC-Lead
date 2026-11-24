import { SlotUnavailable, availableOptions, chosenOption, externalBookingLink, slotMessage } from './booking.js';
import { ClinicError } from './clinics.js';
import { OpportunityError } from './crm.js';
import { clinicFacts } from './clinic-data.js';
import { addAcknowledgment, bookingHandoffReply, explicitHandoff, handoffReasons, mentionsOnlineBooking, normalize, wantsAssessment } from './agent.js';
import { closingContext, isContactPrompt, mentionsPrice, validSalesReply } from './sales.js';
import { KnowledgeError, safeReply } from './knowledge.js';

function errorStatus(error) {
  const status = error?.status ?? error?.response?.status;
  return Number.isInteger(status) ? status : 0;
}

export function createWorker({ store, decide, integrationFor, crmFor, documents, feedback, logger = console }) {
  let timer;
  let active;
  let nextPrune = 0;

  async function offerBookingLink(store, job, booking, acknowledgment) {
    const externalRef = job.id.slice(0, 32);
    await store.plan(job, { kind: 'booking_message', acknowledgment,
      text: 'Você pode escolher um horário e confirmar sua consulta na agenda da clínica:\n' +
        externalBookingLink(booking.bookingLink, externalRef),
      bookingOffer: { externalRef, leadId: job.event.leadId, conversationId: job.event.conversationId } }, 'send');
  }

  async function offerSlots(store, job, crm, booking, turn, prefix = '', acknowledgment) {
    const options = availableOptions(await crm.slots(booking), booking, turn);
    if (!options.length && booking.bookingLink) return offerBookingLink(store, job, booking, acknowledgment);
    const text = options.length ? prefix + slotMessage(options)
      : prefix + 'No momento não encontrei horários disponíveis. Você pode tentar novamente mais tarde.';
    await store.plan(job, { kind: 'booking_message', text, acknowledgment,
      bookingOffer: options.length ? { calendarId: booking.calendarId, options, turn } : null }, 'send');
  }

  async function processJob(store, job) {
    if (!job.event.bookingConfirmation && !job.plan && await store.paused(job.clinica_id, job.lead)) return store.finish(job);
    const integration = await integrationFor(job.clinica_id);
    if (integration.provider !== job.event.provider) throw new ClinicError('O CRM do evento não corresponde à clínica.');
    const crm = crmFor(integration)[job.event.provider];
    const booking = integration.booking ?? {};
    if (job.event.bookingConfirmation) {
      await crm.qualify(job.event);
      return store.finish(job);
    }
    const officialReplies = new Set(clinicFacts(integration.knowledge.clinicData).values());
    const allowed = text => validSalesReply(text) && !mentionsOnlineBooking(text) &&
      (officialReplies.has(text) || (!mentionsPrice(text) && safeReply(text)));
    const allowedDecision = plan => allowed(plan.text) ||
      (allowed(plan.baseText) && plan.text === addAcknowledgment(plan.baseText, plan.acknowledgment));
    const needsDecision = !job.plan || (job.plan.kind === 'responder' && !allowedDecision(job.plan));
    if (needsDecision) {
      const history = await store.history(job);
      const lead = normalize(job.event.text);
      const pending = history.at(-1)?.agenda_ofertada;
      if (booking.calendarId && pending && !explicitHandoff(lead) && !wantsAssessment(lead) &&
          !/\b(?:vou pensar|nao quero|desisti|outra hora)\b/.test(lead)) {
        if (pending.calendarId !== booking.calendarId) {
          await offerSlots(store, job, crm, booking, pending.turn, 'A agenda foi atualizada. ');
        } else {
          const picked = chosenOption(job.event.text, pending.options);
          if (picked >= 0) {
            await store.plan(job, { kind: 'book', slot: pending.options[picked], turn: pending.turn,
              calendarId: pending.calendarId }, 'book');
          } else {
            const prompt = pending.options.length === 1 ? 'Responda 1 para escolher o horário.' : 'Responda 1 ou 2 para indicar sua preferência.';
            await store.plan(job, { kind: 'booking_message',
              text: history.at(-1).outbound.endsWith(prompt) ? slotMessage(pending.options) : prompt,
              bookingOffer: pending }, 'send');
          }
        }
      } else {
        const search = [job.event.text, history.at(-1)?.inbound].filter(Boolean).join(' ');
        const [references, corrections] = isContactPrompt(history.at(-1)?.outbound) ? [[], []] : await Promise.all([
          documents?.context(job.clinica_id, search) ?? [], feedback?.list(job.clinica_id) ?? []
        ]);
        const decision = await decide(job.event, history, {
          ...integration.knowledge, references, feedback: corrections.map(row => row.conteudo)
        });
        if (decision.kind === 'transbordo_humano') await store.plan(job, decision, 'handoff');
        else if (decision.kind === 'qualificar_agendamento') {
          if (booking.calendarId) await offerSlots(store, job, crm, booking, decision.turn, '', decision.acknowledgment);
          else if (booking.bookingLink) await offerBookingLink(store, job, booking, decision.acknowledgment);
          else await store.plan(job, decision, 'qualify');
        } else {
          if (!allowedDecision(decision)) throw new KnowledgeError('Resposta inválida');
          await store.plan(job, decision, 'send');
        }
      }
    }
    if (job.step === 'book') {
      const { slot, calendarId, turn } = job.plan;
      if (!booking.calendarId) throw new ClinicError('O calendário de agendamento foi removido.');
      try {
        if (calendarId !== booking.calendarId || Date.parse(slot.start) <= Date.now() ||
            !(await crm.slots(booking)).some(value => Date.parse(value) === Date.parse(slot.start))) throw new SlotUnavailable();
        await store.startEffect(job);
        const appointmentId = await crm.book(job.event, booking, slot.start);
        await store.plan(job, { ...job.plan, appointmentId }, 'booked_stage');
      } catch (error) {
        if (!(error instanceof SlotUnavailable)) throw error;
        await offerSlots(store, job, crm, booking, turn, 'Esse horário não está mais disponível. ');
      }
    }
    if (job.step === 'booked_stage') {
      await crm.qualify(job.event);
      await store.plan(job, { kind: 'booking_message', text: 'Sua avaliação está confirmada para ' + job.plan.slot.text + '.' }, 'send');
    }
    if (job.step === 'qualify') {
      try {
        await crm.qualify(job.event);
        await store.plan(job, { ...job.plan, erp: true }, 'handoff');
      } catch (error) {
        if (!(error instanceof OpportunityError)) throw error;
        await store.plan(job, { ...job.plan, erp: true, faltaOportunidade: true }, 'handoff');
      }
    }
    if (job.step === 'send' && job.plan.kind === 'qualificar_agendamento' && !job.plan.erp) {
      await store.plan(job, { ...job.plan, erp: true }, 'handoff');
    }
    if (job.step === 'handoff') {
      const booking = job.plan.kind === 'qualificar_agendamento';
      let reason = handoffReasons[booking ? 'agendamento' : job.plan.reason] + closingContext(job.plan);
      if (job.plan.faltaOportunidade) reason += ' ' + handoffReasons.oportunidade;
      await store.startEffect(job);
      await crm.handoff(job.event, reason, job.id.slice(0, 16));
      if (!booking) return store.finish(job);
      await store.plan(job, job.plan, 'send');
    }
    if (job.step !== 'send') throw new Error('Etapa inválida');
    let text = job.plan.kind === 'qualificar_agendamento' ? bookingHandoffReply : job.plan.text;
    if (job.plan.kind === 'responder') {
      if (!allowedDecision(job.plan)) throw new KnowledgeError('Resposta inválida');
    } else if (job.plan.deliveryText) {
      text = job.plan.deliveryText;
    } else if (decide.styleReply) {
      const history = await store.history(job);
      text = job.plan.acknowledgment
        ? addAcknowledgment(text, job.plan.acknowledgment, history.at(-1)?.outbound)
        : (await decide.styleReply(text, history)).text;
      await store.plan(job, { ...job.plan, deliveryText: text }, 'send');
    }
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
