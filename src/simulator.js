import { normalize, explicitHandoff, wantsAssessment, allowBooking, handoffReasons, replies } from './agent.js';
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
  if (fact) return { kind: 'responder', text: fact };
  const query = words(text);
  const ranked = Array.from(knowledge.replies, ([id, answer]) => ({
    answer, score: matches(id.replaceAll('_', ' ') + ' ' + answer, query)
  })).sort((a, b) => b.score - a.score);
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

export async function simulate({ clinic, text, history, withAI, knowledge, decide }) {
  const result = withAI ? await decide({ text }, history, knowledge) : offline(text, history, knowledge);
  const hasAgenda = Boolean(clinic?.agendamento_url);
  let answer = result.text;
  if (!hasAgenda && result.kind === 'responder') {
    if (answer === replies.avaliacao) answer = 'Entendo sua dúvida. A equipe pode avaliar seu caso em uma consulta. Quer simular o agendamento?';
    if (answer === replies.sem_informacao) answer = 'Essa informação ainda não está disponível. Quer simular o agendamento?';
    if (answer === replies.convidar) {
      answer = /^(?:oi|ola|bom dia|boa tarde|boa noite)[.! ]*$/u.test(normalize(text))
        ? 'Oi! Como posso ajudar?' : 'Quer simular o agendamento de uma consulta?';
    }
  }
  const reply = result.kind === 'qualificar_agendamento'
    ? (!hasAgenda ? 'Sua intenção de agendar foi identificada. Neste teste, a clínica ainda não tem um link de agenda.'
      : 'Perfeito! Escolha o melhor horário por aqui:\n' + clinic.agendamento_url)
    : result.kind === 'transbordo_humano'
      ? 'Vou encaminhar sua conversa para a equipe.'
      : answer;
  const action = result.kind === 'qualificar_agendamento' ? (clinic?.crm_tipo ? 'Mover para agendamento' : 'Agendamento simulado')
    : result.kind === 'transbordo_humano' ? 'Transbordo · ' + handoffReasons[result.reason] : 'Responder ao lead';
  return {
    reply, action, offered: Boolean(result.offer && answer !== 'Oi! Como posso ajudar?'),
    sources: knowledge.references.map(item => item.nome),
    feedbackCount: knowledge.feedback?.length ?? 0
  };
}
