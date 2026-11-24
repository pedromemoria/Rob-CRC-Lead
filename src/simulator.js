import { normalize, explicitHandoff, wantsAssessment, allowBooking, handoffReasons, replies } from './agent.js';
import { terms } from './documents.js';

const words = text => terms(normalize(text));
const matches = (text, query) => words(text).filter(word => query.includes(word)).length;

function offline(text, history, knowledge) {
  const normalized = normalize(text);
  const reason = explicitHandoff(normalized);
  if (reason) return { kind: 'transbordo_humano', reason };
  if (wantsAssessment(normalized)) return { kind: 'responder', text: replies.avaliacao, offer: true };
  if (allowBooking(text, text, Boolean(history.at(-1)?.offered))) return { kind: 'qualificar_agendamento' };
  const query = words(text);
  const ranked = Array.from(knowledge.replies, ([id, answer]) => ({
    answer, score: matches(id.replaceAll('_', ' ') + ' ' + answer, query)
  })).sort((a, b) => b.score - a.score);
  if (ranked[0]?.score > 0) return { kind: 'responder', text: ranked[0].answer };
  return { kind: 'responder', text: replies.convidar, offer: true };
}

export function validHistory(history) {
  return Array.isArray(history) ? history.slice(-12).filter(turn =>
    typeof turn?.inbound === 'string' && typeof turn?.outbound === 'string'
  ).map(turn => ({
    inbound: turn.inbound.slice(0, 1000), outbound: turn.outbound.slice(0, 2500), offered: turn.offered === true
  })) : [];
}

export async function simulate({ clinic, text, history, withAI, knowledge, decide }) {
  const result = withAI ? await decide({ text }, history, knowledge) : offline(text, history, knowledge);
  const reply = result.kind === 'qualificar_agendamento'
    ? 'Perfeito! Escolha o melhor horário por aqui:\n' + clinic.agendamento_url
    : result.kind === 'transbordo_humano'
      ? 'Vou encaminhar sua conversa para a equipe.'
      : result.text;
  const action = result.kind === 'qualificar_agendamento' ? 'Mover para agendamento'
    : result.kind === 'transbordo_humano' ? 'Transbordo · ' + handoffReasons[result.reason] : 'Responder ao lead';
  return { reply, action, offered: Boolean(result.offer), sources: knowledge.references.map(item => item.nome) };
}
