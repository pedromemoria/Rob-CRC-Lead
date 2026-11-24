export class ClinicDataError extends Error {}

export const maxRows = 20;
export const maxObservations = 3000;
export const contactFields = [
  ['endereco', 'Endereço completo', 190],
  ['referencia', 'Ponto de referência', 120],
  ['maps_url', 'Link do Google Maps', 1024],
  ['horario', 'Horário de funcionamento', 160],
  ['recepcao', 'WhatsApp ou telefone da recepção', 30]
];
export const professionalFields = [
  ['nome', 'Nome do profissional', 100],
  ['especialidade', 'Especialidade', 100],
  ['registro', 'Registro profissional (CRM, CRO etc.)', 60]
];
export const serviceFields = [
  ['nome', 'Serviço', 90],
  ['descricao', 'Descrição breve', 180],
  ['valor', 'Valor ou faixa de preço', 85],
  ['duracao', 'Duração média', 45],
  ['pagamento', 'Formas de pagamento', 110],
  ['convenios', 'Convênios aceitos', 130]
];

function textField(value, limit, label) {
  if (typeof value !== 'string' || value.trim().length > limit) {
    throw new ClinicDataError('Confira o campo ' + label + '.');
  }
  return value.trim().normalize('NFKC');
}

function publicField(value, limit, label) {
  const text = textField(value, limit, label);
  if (text.length > limit ||
      !/^[\p{Script=Latin}\d .,!?'’"()\-–—+%$€£ºª/:;&°²]*$/u.test(text) ||
      /\b(?:https?|www|mailto|tel)\b|\/\/|[\p{L}\d]\.[\p{L}]|\b\d+(?:\.\d+){2,}\b/iu.test(text)) {
    throw new ClinicDataError('Use texto sem links no campo ' + label + '.');
  }
  return text;
}

function mapsLink(value, limit, label) {
  const text = textField(value, limit, label);
  if (!text) return '';
  const url = URL.parse(text);
  const allowed = url && (
    (['www.google.com', 'google.com', 'www.google.com.br', 'google.com.br'].includes(url.hostname) &&
      /^\/maps(?:\/|$)/.test(url.pathname)) ||
    ['maps.google.com', 'maps.google.com.br', 'maps.app.goo.gl'].includes(url.hostname) ||
    (url.hostname === 'goo.gl' && /^\/maps\//.test(url.pathname))
  );
  if (!allowed || url.protocol !== 'https:' || url.href.length > limit || url.username || url.password || url.port ||
      /[\s\\\u0000-\u001f\u007f]/u.test(text)) {
    throw new ClinicDataError('Informe um link HTTPS oficial do Google Maps.');
  }
  return url.href;
}

const list = value => Array.isArray(value) ? value : value === undefined ? [] : [value];

function readRows(form, prefix, fields) {
  const columns = fields.map(([key]) => list(form[prefix + '_' + key]));
  const count = columns[0].length;
  if (count > maxRows || columns.some(column => column.length !== count)) {
    throw new ClinicDataError('Confira as linhas do formulário. O limite é de ' + maxRows + ' profissionais e ' + maxRows + ' serviços.');
  }
  return Array.from({ length: count }, (_, index) =>
    Object.fromEntries(fields.map(([key], column) => [key, columns[column][index]]))
  );
}

export function clinicDataFromForm(form) {
  return {
    contato: Object.fromEntries(contactFields.map(([key]) => [key, form[key] ?? ''])),
    profissionais: readRows(form, 'prof', professionalFields),
    servicos: readRows(form, 'serv', serviceFields),
    observacoes: form.observacoes ?? ''
  };
}

export function validateClinicData(draft) {
  const contato = Object.fromEntries(contactFields.map(([key, label, max]) => [
    key, (key === 'maps_url' ? mapsLink : publicField)(draft.contato[key], max, label)
  ]));
  if (contato.recepcao && (!/^\+?[\d() -]+$/.test(contato.recepcao) || !/^\d{8,15}$/.test(contato.recepcao.replace(/\D/g, '')))) {
    throw new ClinicDataError('Informe o telefone ou WhatsApp da recepção com DDD.');
  }
  function rows(items, fields) {
    const names = new Set();
    return items.map(row => Object.fromEntries(fields.map(([key, label, max]) => [
      key, publicField(row[key], max, label)
    ]))).filter(row => Object.values(row).some(Boolean)).map(row => {
      const name = normalized(row.nome);
      if (!name || names.has(name)) throw new ClinicDataError('Informe nomes distintos em todas as linhas preenchidas.');
      names.add(name);
      return row;
    });
  }
  const observacoes = textField(draft.observacoes, maxObservations, 'Observações gerais')
    .split(/\r?\n/).map(line => publicField(line, 320, 'Observações gerais')).filter(Boolean).join('\n');
  return {
    contato, profissionais: rows(draft.profissionais, professionalFields), servicos: rows(draft.servicos, serviceFields), observacoes
  };
}

function normalized(value) {
  return value.normalize('NFD').replace(/\p{Mark}+/gu, '').toLowerCase().trim();
}

export function clinicFacts(data) {
  const options = new Map();
  const add = (id, label, value) => {
    if (value) options.set('cadastro_' + id, label + ': ' + value);
  };
  const contact = data?.contato ?? {};
  add('local', 'Endereço', contact.endereco);
  add('referencia', 'Ponto de referência', contact.referencia);
  add('horario', 'Horário de funcionamento', contact.horario);
  add('recepcao', 'Telefone ou WhatsApp da recepção', contact.recepcao);
  const staff = data?.profissionais ?? [];
  add('profissionais', 'Corpo clínico', staff.map(row => row.nome).join(', '));
  staff.forEach((row, index) => {
    add('profissional_' + index, 'Profissional', [row.nome, row.especialidade, row.registro].filter(Boolean).join(' · '));
  });
  const services = data?.servicos ?? [];
  add('servicos', 'Serviços oferecidos', services.map(row => row.nome).join(', '));
  services.forEach((row, index) => {
    add('servico_' + index + '_descricao', row.nome, row.descricao);
    if (row.valor) {
      const description = row.descricao?.length <= 90 && !row.descricao.includes('?') ? row.descricao : '';
      const scope = description ? ' O cadastro informa: ' + description.replace(/[.!]$/, '') + '.'
        : ' A equipe pode explicar o que está incluso.';
      options.set('cadastro_servico_' + index + '_valor',
        'Entendo que o valor seja importante. ' + row.nome + ': ' + row.valor.replace(/[.!]$/, '') + '.' + scope);
    }
    add('servico_' + index + '_duracao', 'Duração média de ' + row.nome, row.duracao);
    add('servico_' + index + '_pagamento', 'Formas de pagamento de ' + row.nome, row.pagamento);
    add('servico_' + index + '_convenios', 'Convênios de ' + row.nome, row.convenios);
  });
  const observations = data?.observacoes?.split('\n') ?? [];
  observations.forEach((line, index) => add('observacao_' + index, 'Orientação da clínica', line));
  return options;
}

function named(items, query) {
  const words = value => normalized(value).match(/[a-z0-9]+/g)?.join(' ') ?? '';
  const text = ' ' + words(query) + ' ';
  const matches = items.map((item, index) => ({ index, key: words(item.nome) }))
    .filter(item => item.key && text.includes(' ' + item.key + ' '))
    .sort((a, b) => b.key.length - a.key.length);
  if (!matches.length) return -1;
  const [first, ...others] = matches;
  return others.every(item => first.key !== item.key && (' ' + first.key + ' ').includes(' ' + item.key + ' ')) ? first.index : -2;
}

const followUp = /^(?:e )?(?:(?:qual (?:e )?(?:o |a )?)?(?:quanto custa|quanto (?:e|tempo(?: dura)?)|preco|valor|duracao|pagamento|convenios?)|(?:aceita )?(?:pix|cartao|convenio))[.!? ]*$/;

export function canSelectClinicFact(data, id, message, previous = '') {
  if (id.startsWith('cadastro_observacao_')) return canShareClinicObservation(message);
  const service = /^cadastro_servico_(\d+)_/.exec(id);
  if (!service) return true;
  const services = data?.servicos ?? [];
  const index = named(services, message);
  return Number(service[1]) === (index === -1 && previous && followUp.test(normalized(message)) ? named(services, previous) : index);
}

export function matchClinicFact(data, options, message, previous = '') {
  const text = normalized(message);
  const topic = [
    ['valor', /\b(?:quanto (?:e|custa|fica)|precos?|valores?|custos?)\b/],
    ['duracao', /\b(?:duracao|quanto tempo dura|demora|quantos minutos)\b/],
    ['pagamento', /\b(?:pagamento|parcel[ao]m?|parcelamento|cartao|credito|pix)\b/],
    ['convenios', /\b(?:convenios?|plano de saude|plano|seguro)\b/],
    ['referencia', /\b(?:ponto de referencia|referencia|perto de)\b/],
    ['local', /\b(?:endereco|localizacao|onde (?:fica|e|voces ficam)|maps|mapa|como chegar)\b/],
    ['horario', /\b(?:funcionam?|funcionamento|abre[m]?|fecha[m]?|horarios?)\b/],
    ['recepcao', /\b(?:recepcao|whatsapp|telefone|numero de contato)\b/],
    ['profissional', /\b(?:profissionais?|medic[oa]s?|especialidades?|crm|cro|registro)\b/],
    ['servico', /\b(?:servicos?|procedimentos?|como funciona|o que e|o que inclui)\b/]
  ].find(([, pattern]) => pattern.test(text))?.[0];
  if (!topic) return null;
  if (['valor', 'duracao', 'pagamento', 'convenios', 'servico'].includes(topic)) {
    const services = data?.servicos ?? [];
    let index = named(services, message);
    if (topic === 'servico' && index === -1 && /\b(?:quais|lista|que servicos)\b/.test(text)) {
      return options.get('cadastro_servicos') ?? null;
    }
    if (index === -1 && followUp.test(text)) {
      index = previous ? named(services, previous) : -1;
      if (index === -1 && services.length === 1) index = 0;
    }
    if (index === -1 && topic === 'valor' &&
        /^(?:quanto (?:custa|e|fica)|qual (?:e )?o (?:valor|preco)) (?:da |a )?consulta[.!? ]*$/.test(text)) {
      const consultations = services.map((row, index) => ({ row, index }))
        .filter(({ row }) => /^consulta\b/.test(normalized(row.nome)));
      if (consultations.length === 1) index = consultations[0].index;
    }
    return options.get('cadastro_servico_' + index + '_' + (topic === 'servico' ? 'descricao' : topic)) ?? null;
  }
  if (topic === 'profissional') {
    const index = named(data?.profissionais ?? [], message);
    if (index === -1 && /\b(?:quais|quem)\b/.test(text)) return options.get('cadastro_profissionais') ?? null;
    return options.get('cadastro_profissional_' + index) ?? null;
  }
  return options.get('cadastro_' + topic) ?? null;
}


const observationStopWords = new Set(['aceita', 'clinica', 'como', 'diferencial', 'exame', 'exames',
  'mais', 'minha', 'para', 'pode', 'posso', 'precisa', 'preciso', 'preparo', 'qual', 'quais', 'quem',
  'regra', 'regras', 'sobre', 'tenho', 'voces']);

function canShareClinicObservation(message) {
  const text = normalized(message);
  return !/\b(?:quanto (?:custa|fica)|precos?|valores?|parcelamento|medicamentos?|remedios?|dosagem)\b/.test(text) &&
    !/\b(?:estou gravida|sou (?:diabetic[oa]|hipertens[oa])|tenho (?:diabetes|alergia)|posso (?:tomar|suspender|parar))\b/.test(text);
}

export function matchClinicObservation(data, options, message) {
  if (!canShareClinicObservation(message)) return null;
  const words = value => new Set((normalized(value).match(/[a-z0-9]{4,}/g) ?? [])
    .filter(word => !observationStopWords.has(word)));
  const query = words(message);
  if (!query.size) return null;
  const notes = data?.observacoes?.split('\n') ?? [];
  const ranked = notes.map((line, index) => ({
    index, score: [...words(line)].filter(word => query.has(word)).length
  })).filter(row => row.score > 0).sort((a, b) => b.score - a.score);
  const [best, next] = ranked;
  if (!best || (next && next.score === best.score)) return null;
  return options.get('cadastro_observacao_' + best.index) ?? null;
}
