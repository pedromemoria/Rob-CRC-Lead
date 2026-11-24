import { clinicFacts, matchClinicFact } from './clinic-data.js';

export const normalize = text => text.normalize('NFD').replace(/\p{Mark}+/gu, '').toLowerCase().trim();

export const salesReplies = {
  situacao: 'Entendo que você esteja buscando orientação. Essa consulta seria para você ou para um familiar?',
  problema: 'Entendi. O que mais te preocupa nessa situação?',
  impacto: 'Faz sentido querer entender isso melhor. Como essa situação tem afetado sua rotina?',
  necessidade: 'Entendo como isso pode pesar na rotina. Faz sentido conversar com a equipe em uma avaliação?',
  turno: 'Entendi, você quer agendar. Prefere que a equipe verifique horários de manhã ou à tarde?',
  preco_contexto: 'Entendo que o valor seja importante. A avaliação ajuda a esclarecer o que faz sentido para você. Qual serviço você procura?',
  preco_objecao: 'Faz sentido avaliar o investimento com calma. Quer que a equipe explique o que está incluso na consulta?',
  pensar: 'Claro, é uma decisão importante. Tem alguma dúvida que eu possa esclarecer enquanto você decide?',
  tempo: 'Entendo, a rotina pode ser corrida. Prefere que a equipe verifique opções de manhã ou à tarde?',
  sem_preco: 'Entendo que o valor seja importante. A equipe pode confirmar o preço e explicar o que está incluso.'
};

const priceQuestion = /\b(?:quanto (?:e|custa|fica)|precos?|valores?|custos?|so quero saber quanto)\b/;
const priceInsistence = /\b(?:so (?:quero|preciso) saber|insisto|me (?:diga|informe) (?:logo|apenas|so)|ja perguntei|sem rodeios|antes de tudo)\b/;
const noPressure = /\b(?:vou pensar|preciso pensar|quero pensar|vou (?:falar|conversar) com|falo com|vou decidir|depois eu (?:vejo|decido))\b/;
const turns = new Map([['manha', 'manhã'], ['tarde', 'tarde']]);

export function preferredTurn(text) {
  const result = [...normalize(text).matchAll(/\b(manha|tarde)\b/g)].map(match => match[1]);
  return new Set(result).size === 1 ? turns.get(result[0]) : undefined;
}

export function validSalesReply(text) {
  return typeof text === 'string' && text.trim() && text.length <= 320 &&
    text.split(/\r?\n/).length <= 4 && (text.match(/\?/g)?.length ?? 0) <= 1 &&
    (!text.includes('?') || /^(?:oi|ola|entend[oi]|faz sentido|claro|com certeza|obrigad[oa]|agradeco)\b/.test(normalize(text))) &&
    !/\b(?:pre[- ]?reserv\w*|(?:horarios?|vagas?) (?:acabando|limitad[oa]s?)|(?:temos|tenho) (?:vaga|disponibilidade|horario)|garant\w* (?:cura|resultado))\b/.test(normalize(text));
}

export function mentionsPrice(text) {
  return typeof text === 'string' && /(?:R\$|[$€£]\s*\d|\b\d[\d., ]*\s*(?:reais|euros|dolares)\b|\b(?:valor|preco|custa)\b[^.?!]{0,55}\d|\b(?:consulta|avaliacao|procedimento) (?:e )?(?:gratuit[oa]|sem custo))/i.test(normalize(text));
}

const turnOffer = text => [salesReplies.turno, salesReplies.tempo].includes(text);
const offer = text => [salesReplies.turno, salesReplies.tempo, salesReplies.necessidade].includes(text);
const response = (text, booking = false) => ({ kind: 'responder', text, offer: booking || offer(text) });

export function consultativeDecision(text, history, knowledge, booking) {
  const lead = normalize(text);
  const last = history.at(-1);
  if (noPressure.test(lead)) return response(salesReplies.pensar);
  const chosenTurn = /\b(?:prefiro|melhor|pode ser)\b.{0,20}\b(manha|tarde)\b/.exec(lead)?.[1];
  const turn = turns.get(chosenTurn) ?? preferredTurn(lead);
  const priorTurnOffer = turnOffer(last?.outbound);
  const acceptsTurn = /^(?:(?:prefiro|melhor|pode ser|de preferencia|quero) )?(?:(?:no periodo )?(?:de|a|da|pela) )?(?:manha|tarde)[.! ]*$/.test(lead) ||
    /\b(?:prefiro|para mim|melhor|consigo|so posso)\b.{0,32}\b(?:manha|tarde)\b/.test(lead);
  if (turn && (booking || (priorTurnOffer && acceptsTurn)) && !/\b(?:talvez|so se|depende|nao quero)\b/.test(lead) &&
      (!/\bnao\b/.test(lead) || Boolean(chosenTurn))) {
    return { kind: 'qualificar_agendamento', turn };
  }
  if (booking || /\b(?:preciso (?:de |fazer )?(?:uma )?avaliacao|faz sentido (?:uma |fazer uma )?avaliacao|quero (?:uma )?consulta)\b/.test(lead) &&
      !/\b(?:nao|talvez|depois)\b/.test(lead)) {
    return response(salesReplies.turno);
  }
  if (priceQuestion.test(lead)) {
    const discussed = history.some(step => step.outbound === salesReplies.necessidade ||
      step.outbound === salesReplies.impacto || step.outbound === salesReplies.preco_contexto);
    const repeated = history.slice(-4).some(step => priceQuestion.test(normalize(step.inbound ?? '')));
    if (!discussed && !repeated && !priceInsistence.test(lead)) return response(salesReplies.preco_contexto);
    const priceFacts = new Map([...clinicFacts(knowledge.clinicData)].filter(([id]) => id.endsWith('_valor')));
    const price = matchClinicFact(knowledge.clinicData, priceFacts, text, last?.inbound);
    return response(validSalesReply(price) ? price : salesReplies.sem_preco);
  }
  if (/\b(?:ta caro|esta caro|ficou caro|muito caro|fora do orcamento)\b/.test(lead)) return response(salesReplies.preco_objecao);
  if (/\b(?:sem tempo|nao tenho tempo|rotina corrida|muito ocupad[oa])\b/.test(lead)) return response(salesReplies.tempo);
  return null;
}

export function consultativeFallback(history, lead) {
  if (!history.length) return response(lead
    ? 'Oi, ' + lead + '! Que bom falar com você. Como posso ajudar?'
    : 'Oi! Como posso ajudar?');
  const phases = [salesReplies.situacao, salesReplies.problema, salesReplies.impacto, salesReplies.necessidade];
  const furthest = history.reduce((phase, turn) => Math.max(phase, phases.indexOf(turn.outbound)), -1);
  return response(phases[furthest + 1] ??
    'Entendo. Se quiser conversar mais sobre a avaliação, fico à disposição.');
}

export function firstName(value) {
  const word = typeof value === 'string' ? value.trim().split(/\s+/u)[0] : '';
  return /^[\p{Script=Latin}][\p{Script=Latin}\p{Mark}'’-]{1,29}$/u.test(word) ? word : undefined;
}

export function qualifiedTurnContext(turn) {
  return ['manhã', 'tarde'].includes(turn) ? ' Turno de preferência informado pelo lead: ' + turn + '.' : '';
}
