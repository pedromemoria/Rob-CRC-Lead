import { normalize, explicitHandoff, wantsAssessment, allowBooking, handoffReasons, bookingHandoffReply, mentionsOnlineBooking, replies } from './agent.js';
import { clinicFacts, matchClinicFact, matchClinicObservation } from './clinic-data.js';
import { terms } from './documents.js';

const words = text => terms(normalize(text));
const matches = (text, query) => words(text).filter(word => query.includes(word)).length;

function offline(text, history, knowledge) {
  const normalized = normalize(text);
  const reason = explicitHandoff(normalized);
  if (reason) return { kind: 'transbordo_humano', reason };
  if (wantsAssessment(normalized)) return { kind: 'responder', text: replies.avaliacao, offer: true };
  if (allowBooking(text, text, Boolean(history.at(-1)?.offered))) return { kind: 'qualificar_agendamento' };
  const facts = clinicFacts(knowledge.clinicData);
  const fact = matchClinicFact(knowledge.clinicData, facts, text, history.at(-1)?.inbound) ??
    matchClinicObservation(knowledge.clinicData, facts, text);
  if (fact && !mentionsOnlineBooking(fact)) return { kind: 'responder', text: fact };
  const query = words(text);
  const ranked = Array.from(knowledge.replies, ([id, answer]) => ({
    answer, score: matches(id.replaceAll('_', ' ') + ' ' + answer, query)
  })).filter(({ answer }) => !mentionsOnlineBooking(answer)).sort((a, b) => b.score - a.score);
  if (ranked[0]?.score > 0) return { kind: 'responder', text: ranked[0].answer };
  if (knowledge.clinicName && /\b(?:quanto custa|precos?|valores?|endereco|horarios?|convenios?|telefone)\b/.test(normalized)) {
    return { kind: 'responder', text: replies.sem_informacao, offer: true };
  }
  return { kind: 'responder', text: replies.convidar, offer: true };
}

export function validHistory(history) {
  return Array.isArray(history) ? history.slice(-12).filter(turn =>
    typeof turn?.inbound === 'string' && typeof turn?.outbound === 'string'
  ).map(turn => ({
    inbound: turn.inbound.slice(0, 1000), outbound: turn.outbound.slice(0, 2500), offered: turn.offered === true
  })) : [];
}

export async function simulate({ text, history, withAI, knowledge, decide }) {
  const result = withAI ? await decide({ text }, history, knowledge) : offline(text, history, knowledge);
  let answer = result.text;
  if (result.kind === 'responder' && mentionsOnlineBooking(answer)) answer = replies.convidar;
  if (result.kind === 'responder' && answer === replies.convidar &&
      /^(?:oi|ola|bom dia|boa tarde|boa noite)[.! ]*$/u.test(normalize(text))) {
    answer = 'Oi! Como posso ajudar?';
  }
  const reply = result.kind === 'qualificar_agendamento' ? bookingHandoffReply
    : result.kind === 'transbordo_humano' ? 'Vou encaminhar sua conversa para a equipe.' : answer;
  const action = result.kind === 'qualificar_agendamento' ? 'Encaminhar para agendamento no ERP'
    : result.kind === 'transbordo_humano' ? 'Transbordo · ' + handoffReasons[result.reason] : 'Responder ao lead';
  return {
    reply, action, offered: Boolean(result.offer && answer !== 'Oi! Como posso ajudar?'),
    sources: knowledge.references.map(item => item.nome),
    feedbackCount: knowledge.feedback?.length ?? 0
  };
}
