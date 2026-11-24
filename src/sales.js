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
    (!text.includes('?') || /^(?:oi|ola|entend[oi]|imagino|faz sentido|claro|com certeza|obrigad[oa]|agradeco)\b/.test(normalize(text))) &&
    !/\b(?:pre[- ]?reserv\w*|(?:horarios?|vagas?) (?:acabando|limitad[oa]s?)|(?:temos|tenho) (?:vaga|disponibilidade|horario)|garant\w* (?:cura|resultado))\b/.test(normalize(text));
}

export function mentionsPrice(text) {
  return typeof text === 'string' && /(?:R\$|[$€£]\s*\d|\b\d[\d., ]*\s*(?:reais|euros|dolares)\b|\b(?:valor|preco|custa)\b[^.?!]{0,55}\d|\b(?:consulta|avaliacao|procedimento) (?:e )?(?:gratuit[oa]|sem custo))/i.test(normalize(text));
}

const closingPrompts = {
  objetivo: [
    'Claro, posso ajudar a agendar. Qual especialidade ou objetivo você tem em mente?',
    'Tudo bem. Que tipo de consulta você procura?'
  ],
  turno: [
    salesReplies.turno,
    'Claro. Para eu encaminhar o pedido, qual turno funciona melhor para você, manhã ou tarde?'
  ],
  nome: [
    'Entendi sua preferência de turno. Qual é seu nome completo para a equipe localizar o cadastro?',
    'Entendi. Pode me informar seu nome e sobrenome para encaminhar o pedido?'
  ],
  telefone: [
    'Obrigado. Qual telefone ou WhatsApp com DDD a equipe pode usar para confirmar?',
    'Tudo bem. Qual é o melhor número para retorno, incluindo o DDD?'
  ]
};

const stableReplies = new Set([...Object.values(closingPrompts).flat(), ...Object.values(salesReplies)]);

export function baseSalesReply(text) {
  if (typeof text !== 'string') return text;
  const separator = text.indexOf('\n');
  const suffix = separator >= 0 ? text.slice(separator + 1) : text;
  return stableReplies.has(suffix) ? suffix : text;
}

const turnOffer = text => [...closingPrompts.turno, salesReplies.tempo].includes(baseSalesReply(text));
const offer = text => turnOffer(text) || text === salesReplies.necessidade;
const response = (text, booking = false) => ({ kind: 'responder', text, offer: booking || offer(text) });

function askClosing(step, last) {
  const [first, alternate] = closingPrompts[step];
  return response(sameReply(last, first) ? alternate : first);
}

function latestAnswer(history, prompts, parse) {
  for (let index = history.length - 1; index >= 0; index--) {
    if (!prompts.includes(baseSalesReply(history[index].outbound))) continue;
    const value = parse(history[index + 1]?.inbound ?? '');
    if (value) return value;
  }
}

export function fullName(value) {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().replace(/^(?:meu nome (?:é|e|eh)|me chamo|(?:nome completo|nome)\s*:)\s*/iu, '')
    .replace(/[.!]$/u, '').replace(/\s+/g, ' ');
  if (name.length < 5 || name.length > 80 || !/^[\p{L}\p{M}'’-]+(?: [\p{L}\p{M}'’-]+){1,6}$/u.test(name) ||
      /\b(?:nao|quero|prefiro|pode|isso|vou|por favor|manha|tarde|tenho|preciso|depois|nome|telefone|whatsapp|horario|obrigad[oa])\b/.test(normalize(name))) return undefined;
  return name;
}

export function contactPhone(value) {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim().replace(/^(?:(?:meu )?(?:telefone|whatsapp|celular|número|numero)(?:\s+(?:é|e|eh))?\s*:?\s*)/iu, '');
  if (!/^\+?[0-9() -]{10,25}$/u.test(cleaned)) return undefined;
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return undefined;
  return (cleaned.startsWith('+') ? '+' : '') + digits;
}

function turnChoice(text) {
  const lead = normalize(text);
  const chosen = /\b(?:prefiro|melhor|pode ser)\b.{0,20}?\b(manha|tarde)\b/.exec(lead)?.[1];
  if (/\b(?:talvez|so se|depende|nao quero)\b/.test(lead) || (!chosen && /\bnao\b/.test(lead))) return undefined;
  return turns.get(chosen) ?? preferredTurn(lead);
}

const specialties = [
  ['urologia', /\burolog\w*\b/],
  ['odontologia', /\b(?:dent\w*|odont\w*)\b/],
  ['cardiologia', /\bcardiolog\w*\b/],
  ['dermatologia', /\bdermatolog\w*\b/],
  ['ginecologia', /\bginecolog\w*\b/],
  ['pediatria', /\bpediatr\w*\b/],
  ['ortopedia', /\bortoped\w*\b/],
  ['oftalmologia', /\boftalmolog\w*\b/],
  ['fisioterapia', /\bfisioterap\w*\b/]
];
const mentionsGoal = text => /\b(?:especialidade|urolog\w*|dent\w*|cardiolog\w*|dermatolog\w*|ginecolog\w*|pediatr\w*|ortoped\w*|oftalmolog\w*|psicolog\w*|nutri\w*|fisioterap\w*|exame|retorno|check[- ]?up|cirurgia|tratamento|limpeza|dor|incomodo|sintoma)\b/.test(normalize(text));

const sameReply = (first, second) => normalize(first ?? '').replace(/[^\p{L}\d]+/gu, ' ').trim() ===
  normalize(second ?? '').replace(/[^\p{L}\d]+/gu, ' ').trim();

export function nonRepeatingDecision(decision, history) {
  if (decision.kind !== 'responder' || !sameReply(decision.text, baseSalesReply(history.at(-1)?.outbound))) return decision;
  for (const [step, prompts] of Object.entries(closingPrompts)) {
    if (prompts.includes(decision.text)) {
      return response(prompts.find(prompt => !sameReply(prompt, decision.text)), step === 'turno');
    }
  }
  const progress = consultativeFallback(history);
  if (!sameReply(progress.text, decision.text)) return progress;
  return response('Tudo bem. Posso ajudar com uma dúvida sobre a consulta ou encaminhar um pedido de agendamento.');
}

export function isContactPrompt(outbound) {
  const previous = baseSalesReply(outbound);
  return closingPrompts.nome.includes(previous) || closingPrompts.telefone.includes(previous);
}

export function modelHistory(history) {
  const result = history.map((turn, index) => {
    const previous = history[index - 1]?.outbound;
    return { lead: isContactPrompt(previous) ? '[dado de contato para agendamento]' : turn.inbound, sdr: turn.outbound };
  });
  let chars = 0;
  return result.reverse().filter(turn => {
    const size = (turn.lead?.length ?? 0) + (turn.sdr?.length ?? 0);
    chars += size;
    return chars <= 80_000;
  }).reverse();
}

export function closingContext(plan) {
  const turn = turns.get(normalize(plan.turn ?? ''));
  const name = fullName(plan.contactName);
  const phone = contactPhone(plan.contactPhone);
  return (turn ? ' Turno de preferência informado pelo lead: ' + turn + '.' : '') +
    (name ? ' Nome completo: ' + name + '.' : '') +
    (phone ? ' Telefone ou WhatsApp: ' + phone + '.' : '');
}

export function consultativeDecision(text, history, knowledge, booking, event = {}) {
  const lead = normalize(text);
  const last = history.at(-1);
  const previous = baseSalesReply(last?.outbound);
  if (noPressure.test(lead) || /\b(?:(?:nao quero|nao preciso) (?:mais|agendar|marcar|fazer|de uma avaliacao)|nao tenho interesse|desisti|melhor nao)\b/.test(lead)) {
    return response(salesReplies.pensar);
  }

  const awaitingName = closingPrompts.nome.includes(previous);
  const awaitingPhone = closingPrompts.telefone.includes(previous);
  if (awaitingName || awaitingPhone || (turnChoice(text) && (booking || turnOffer(previous)))) {
    const turn = awaitingName || awaitingPhone
      ? latestAnswer(history, [...closingPrompts.turno, salesReplies.tempo], turnChoice) ??
        history.slice(-6).map(step => turnChoice(step.inbound ?? '')).filter(Boolean).at(-1)
      : turnChoice(text);
    const name = (awaitingName ? fullName(text) : undefined) ??
      latestAnswer(history, closingPrompts.nome, fullName) ?? fullName(event.contactName);
    const phone = (awaitingPhone ? contactPhone(text) : undefined) ?? contactPhone(event.contactPhone);
    const giveUp = /\b(?:prefiro nao|nao quero (?:informar|passar)|uso este numero|e este numero|o mesmo numero)\b/.test(lead);
    if (!name && !awaitingPhone && !giveUp && previous !== closingPrompts.nome[1]) {
      return askClosing('nome', previous);
    }
    if (!phone && !giveUp && previous !== closingPrompts.telefone[1]) return askClosing('telefone', previous);
    return { kind: 'qualificar_agendamento', turn, contactName: name, contactPhone: phone };
  }

  const evaluation = /\b(?:preciso (?:de |fazer )?(?:uma )?avaliacao|faz sentido (?:uma |fazer uma )?avaliacao|quero (?:uma )?consulta)\b/.test(lead) &&
    !/\b(?:nao|talvez|depois)\b/.test(lead);
  const awaitingGoal = closingPrompts.objetivo.includes(previous);
  if (awaitingGoal && !priceQuestion.test(lead)) {
    return askClosing('turno', previous);
  }
  if (booking || evaluation) {
    const generic = /^(?:eu )?(?:quero|desejo|gostaria de|pretendo|preciso|posso|como faco para|tem como) (?:agendar|marcar)(?: (?:uma? |a |o )?(?:consulta|avaliacao|horario))?[.!? ]*$/.test(lead);
    if (generic && !last?.offered && !history.some(step => mentionsGoal(step.inbound ?? ''))) return askClosing('objetivo', previous);
    return askClosing('turno', previous);
  }

  if (priceQuestion.test(lead)) {
    const discussed = history.some(step => [salesReplies.necessidade, salesReplies.impacto, salesReplies.preco_contexto]
      .includes(baseSalesReply(step.outbound)));
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

export function consultativeFallback(history, lead, message = '') {
  const topics = [message, ...history.slice(-4).reverse().map(turn => turn.inbound ?? '')];
  const specialty = topics.flatMap(topic => specialties.filter(([, pattern]) => pattern.test(normalize(topic))))[0]?.[0];
  const problem = specialty
    ? 'Entendi que você busca atendimento em ' + specialty + '. O que mais te motivou a procurar essa consulta?'
    : salesReplies.problema;
  const goal = Boolean(specialty) || topics.some(mentionsGoal);
  if (!history.length && goal) return response(problem);
  if (!history.length) return response(lead
    ? 'Oi, ' + lead + '! Que bom falar com você. Como posso ajudar?'
    : 'Oi! Como posso ajudar?');
  const phases = [salesReplies.situacao, problem, salesReplies.impacto, salesReplies.necessidade];
  const furthest = history.reduce((phase, turn) => {
    const exact = phases.findIndex(text => turn.outbound?.endsWith(text.match(/[^.!?]+\?$/u)?.[0]?.trim() ?? text));
    const index = turn.outbound?.startsWith('Entendi que você busca atendimento em ') || exact === 1 ? 1 : exact;
    return Math.max(phase, index);
  }, -1);
  return response(phases[goal && furthest < 0 ? 1 : furthest + 1] ??
    'Entendo. Se quiser conversar mais sobre a avaliação, fico à disposição.');
}

export function firstName(value) {
  const word = typeof value === 'string' ? value.trim().split(/\s+/u)[0] : '';
  return /^[\p{Script=Latin}][\p{Script=Latin}\p{Mark}'’-]{1,29}$/u.test(word) ? word : undefined;
}
