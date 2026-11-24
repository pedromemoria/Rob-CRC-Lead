import { normalize, explicitHandoff, wantsAssessment, bookingInterest, eligibleSalesReply, addAcknowledgment, handoffReasons, bookingHandoffReply, replies } from './agent.js';
import { clinicFacts, matchClinicFact, matchClinicObservation } from './clinic-data.js';
import { consultativeDecision, consultativeFallback, nonRepeatingDecision } from './sales.js';
import { availableOptions, chosenOption, slotMessage } from './booking.js';
import { terms } from './documents.js';

const words = text => terms(normalize(text));
const matches = (text, query) => words(text).filter(word => query.includes(word)).length;

function offline(text, history, knowledge) {
  const normalized = normalize(text);
  const reason = explicitHandoff(normalized);
  if (reason) return { kind: 'transbordo_humano', reason };
  if (wantsAssessment(normalized)) return { kind: 'responder', text: replies.avaliacao, offer: true };
  const consultation = consultativeDecision(text, history, knowledge, bookingInterest(text, history));
  if (consultation) return consultation;
  const facts = clinicFacts(knowledge.clinicData);
  const fact = matchClinicFact(knowledge.clinicData, facts, text, history.at(-1)?.inbound) ??
    matchClinicObservation(knowledge.clinicData, facts, text);
  if (eligibleSalesReply(fact)) return { kind: 'responder', text: fact };
  const query = words(text);
  const ranked = Array.from(knowledge.replies, ([id, answer]) => ({
    answer, score: matches(id.replaceAll('_', ' ') + ' ' + answer, query)
  })).filter(({ answer }) => eligibleSalesReply(answer)).sort((a, b) => b.score - a.score);
  if (ranked[0]?.score > 0) return { kind: 'responder', text: ranked[0].answer };
  if (knowledge.clinicName && /\b(?:quanto custa|precos?|valores?|endereco|horarios?|convenios?|telefone)\b/.test(normalized)) {
    return { kind: 'responder', text: replies.sem_informacao, offer: true };
  }
  return consultativeFallback(history, undefined, text);
}

export function validHistory(history) {
  return Array.isArray(history) ? history.slice(-80).filter(turn =>
    typeof turn?.inbound === 'string' && typeof turn?.outbound === 'string'
  ).map(turn => ({
    inbound: turn.inbound.slice(0, 1000), outbound: turn.outbound.slice(0, 2500), offered: turn.offered === true,
    agenda_ofertada: Array.isArray(turn.agenda_ofertada) ? turn.agenda_ofertada.slice(0, 2).filter(option =>
      typeof option?.text === 'string' && option.text.length <= 120 && Number.isFinite(Date.parse(option.start))) : null
  })) : [];
}

export async function simulate({ text, history, withAI, knowledge, decide, booking = {} }) {
  const pending = booking.calendarId && history.at(-1)?.agenda_ofertada;
  if (pending?.length && !explicitHandoff(normalize(text))) {
    const index = chosenOption(text, pending);
    if (index >= 0) {
      const text = 'Reserva simulada para ' + pending[index].text + '.';
      const styled = withAI && decide.styleReply ? await decide.styleReply(text, history) : { text };
      return { reply: styled.text, provider: styled.provider, action: 'Simular alteração para Agendado',
        offered: false, sources: [], feedbackCount: 0 };
    }
  }
  const decision = withAI ? await decide({ text }, history, { ...knowledge, simulator: true }) : offline(text, history, knowledge);
  const result = withAI ? decision : nonRepeatingDecision(decision, history);
  const styled = text => addAcknowledgment(text, decision.acknowledgment, history.at(-1)?.outbound);
  const info = {
    provider: decision.provider,
    sources: withAI ? decision.modelContext?.references?.map(item => item.nome) ?? [] : [],
    feedbackCount: withAI ? decision.modelContext?.feedback?.length ?? 0 : 0
  };
  if (result.kind === 'qualificar_agendamento' && booking.calendarId) {
    const now = Date.now();
    const exampleSlots = [1, 2].map(days => new Date(now + days * 86_400_000).toISOString());
    const options = availableOptions(exampleSlots, booking, result.turn, now);
    return { reply: styled('Horários de exemplo. ' + slotMessage(options)), action: 'Escolher horário simulado',
      agenda_ofertada: options, offered: false, ...info };
  }
  if (result.kind === 'qualificar_agendamento' && booking.bookingLink) {
    return { reply: styled('No atendimento, o robô enviaria o link da agenda da clínica.'), action: 'Simular envio do link',
      offered: false, ...info };
  }
  let reply = result.kind === 'qualificar_agendamento' ? bookingHandoffReply
    : result.kind === 'transbordo_humano' ? 'Vou encaminhar sua conversa para a equipe.' : result.text;
  if (result.kind !== 'responder' && reply === history.at(-1)?.outbound) {
    reply = 'Seu pedido será encaminhado à equipe da clínica.';
  }
  const action = result.kind === 'qualificar_agendamento' ? 'Encaminhar para agendamento no ERP' + (result.turn ? ' · ' + result.turn : '')
    : result.kind === 'transbordo_humano' ? 'Transbordo · ' + handoffReasons[result.reason] : 'Responder ao lead';
  return { reply: result.kind === 'responder' ? reply : styled(reply), action, offered: Boolean(result.offer), ...info };
}
