import { safeReply } from './knowledge.js';
import { normalize } from './sales.js';

export const consultationInvitation = 'Quer marcar a avaliação?';

const objectives = /\b(?:emagrec\w*|hipertrofia|disposicao|hormon\w*|ganhar (?:peso|massa)|perder (?:peso|gordura|barriga)|energia|alimentacao|nutricao|emagrecimento|clareamento|protes\w*|engravida\w*|melhorar|controlar|acompanhar|incomod\w*|dor(?:es)?|cansad\w*|cansaco|libido|sono|prevencao|checkup|check-up)\b/u;
const difficulties = /\b(?:dificuldade|dificil|atrapalh\w*|frustr\w*|nao (?:consigo|consegui|tenho|melhora)|ja tentei|ha (?:meses|anos)|todo dia|desde|acordo|me sinto|me preocupo|me incomoda|me cansa|desanimo|sem (?:energia|disposicao))\b/u;
const inquiry = /^(?:(?:na|no|sobre) [a-z]{3,25}, )?(?:qual|quais|como|quanto|onde|quando|quem|o que|por que|de que forma|me conta|me conte|me diz|pode me contar)\b/u;

export function consultationStage(text, history) {
  let objective = false;
  let difficulty = false;
  const messages = [...history.slice(-10).map(turn => turn.inbound), text];
  for (const message of messages) {
    const lead = normalize(message ?? '');
    if (!lead || lead.endsWith('?') || inquiry.test(lead)) continue;
    const details = lead.match(/[a-z]+/gu)?.length ?? 0;
    if (difficulties.test(lead)) difficulty = true;
    if (objectives.test(lead) || (details >= 3 &&
        /\b(?:meu objetivo|meu foco|quero|busco|preciso|gostaria de)\b.{0,75}\b(?:cuidar|reduzir|aumentar|tratar|investigar|avaliar|entender|resolver|ter|fazer exames)\b/u.test(lead))) objective = true;
  }
  if (!objective) return 'objetivo';
  return difficulty ? 'avaliacao' : 'dificuldade';
}

export function validConsultationQuestion(text) {
  return typeof text === 'string' && text.length <= 180 && safeReply(text) &&
    /^[\p{Script=Latin} ,’'()\-–]+\?$/u.test(text) && inquiry.test(normalize(text)) &&
    !/\b(?:agenda\w*|horario|manh[aã]|tarde|vaga|turno|nome completo|cpf|documento|senha|telefone|whatsapp|e-?mail|endereco|receita|prescrev\w*|receit\w*|diagnostic\w*|remedio|medicamento|dose|dosagem|cura|deve|recomendo|recomendaria|indicaria|sugiro|tom[ae]|tomar|us[ae]|usar|aplicar|iniciar|interromper|garant\w*|combinado|ja registrei|encaminh\w*)\b/u.test(normalize(text));
}

export const fallbackQuestions = {
  objetivo: ['O que você gostaria de melhorar com a avaliação?', 'Qual é o principal objetivo que te trouxe até aqui?'],
  dificuldade: ['O que tem sido mais difícil no seu dia a dia?', 'Como essa dificuldade tem aparecido na sua rotina?']
};

export function validEvaluationDetail(text) {
  return safeReply(text) && text.length <= 180 && !text.includes('?') &&
    /\b(?:avaliacao|consulta|atendimento|acompanhamento)\b/u.test(normalize(text)) &&
    !/\b(?:cura|diagnostic\w*|receit\w*|prescrev\w*|garant\w*|medicamento|dose|encaminh\w*|equipe localizar|combinado|ja registrei)\b/u.test(normalize(text));
}
