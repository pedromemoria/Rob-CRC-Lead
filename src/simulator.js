import { normalize, explicitHandoff, wantsAssessment, bookingInterest, eligibleSalesReply, handoffReasons, bookingHandoffReply, replies } from './agent.js';
import { clinicFacts, matchClinicFact, matchClinicObservation } from './clinic-data.js';
import { consultativeDecision, consultativeFallback } from './sales.js';
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
  return consultativeFallback(history);
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
  const reply = result.kind === 'qualificar_agendamento' ? bookingHandoffReply
    : result.kind === 'transbordo_humano' ? 'Vou encaminhar sua conversa para a equipe.' : result.text;
  const action = result.kind === 'qualificar_agendamento' ? 'Encaminhar para agendamento no ERP' + (result.turn ? ' · ' + result.turn : '')
    : result.kind === 'transbordo_humano' ? 'Transbordo · ' + handoffReasons[result.reason] : 'Responder ao lead';
  return {
    reply, action, offered: Boolean(result.offer),
    sources: knowledge.references.map(item => item.nome),
    feedbackCount: knowledge.feedback?.length ?? 0
  };
}
