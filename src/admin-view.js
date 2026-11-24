import { trainingFields } from './clinics.js';

export const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

export const hidden = (name, value) => '<input type="hidden" name="' + escape(name) + '" value="' + escape(value) + '">';

export const tabs = {
  conexao: 'Conexão & CRM', treinamento: 'Treinamento & Prompts',
  arquivos: 'Arquivos (Base de Conhecimento)', teste: 'Testar Robô'
};

export function adminUrl(clinicId, tab, path = 'treinar') {
  const query = new URLSearchParams();
  if (clinicId) query.set('clinica', clinicId);
  if (tab) query.set('aba', tab);
  return '/admin/' + path + (query.size ? '?' + query : '');
}

const names = { kommo: 'Kommo', ghl: 'GoHighLevel' };
const initials = name => name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0]).join('').toUpperCase();

export function layout({ clinics, current, active, content, operations = false }) {
  const items = clinics.map(row => {
    const href = adminUrl(row.id, operations ? undefined : active, operations ? 'operacao' : 'treinar');
    return '<a class="clinic" href="' + escape(href) + '"' + (row.id === current?.id ? ' aria-current="page"' : '') +
      '><span class="avatar" aria-hidden="true">' + escape(initials(row.nome_clinica)) +
      '</span><span class="clinic-name">' + escape(row.nome_clinica) + '<small>' + escape(names[row.crm_tipo]) + '</small></span></a>';
  }).join('');
  const side = '<aside class="sidebar"><a class="brand" href="/admin/treinar"><span class="mark" aria-hidden="true">+</span>' +
    '<span>Robô CRC<small>Painel administrativo</small></span></a>' +
    '<div class="side-label">Clínicas</div><a class="new" href="/admin/treinar">+ Nova Clínica</a>' +
    '<nav class="clinic-list" aria-label="Clínicas">' + (items || '<p>Nenhuma clínica cadastrada.</p>') + '</nav>' +
    '<a class="side-link" href="' + escape(adminUrl(current?.id, undefined, operations ? 'treinar' : 'operacao')) + '">' +
    (operations ? 'Voltar à configuração' : 'Operação da fila') + '</a></aside>';
  const title = operations ? 'Operação da fila' : current?.nome_clinica ?? 'Nova clínica';
  const navigation = !operations && current ? '<nav class="tabs" aria-label="Seções da clínica">' +
    Object.entries(tabs).map(([value, label]) =>
      '<a href="' + escape(adminUrl(current.id, value)) + '"' + (value === active ? ' aria-current="page"' : '') +
      '>' + escape(label) + '</a>'
    ).join('') + '</nav>' : '';
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(title) +
    ' · Robô CRC</title><link rel="stylesheet" href="/admin/assets/panel.css">' +
    '<script defer src="/admin/assets/panel.js"></script></head><body>' + side +
    '<main id="conteudo"><div class="shell"><header class="page-heading"><h1>' + escape(title) + '</h1>' +
    (current ? '<span class="provider">' + escape(names[current.crm_tipo]) + '</span>' : '') +
    '</header>' + navigation + content + '</div></main></body></html>';
}

function input(source, name, label, type = 'text', attributes = '') {
  return '<div class="field"><label for="' + name + '">' + escape(label) + '</label><input id="' + name +
    '" name="' + name + '" type="' + type + '" value="' + escape(type === 'password' ? '' : source[name]) + '"' +
    attributes + '></div>';
}

const heading = (title, description = '') => '<header class="section-heading"><h2>' + escape(title) + '</h2>' +
  (description ? '<p>' + escape(description) + '</p>' : '') + '</header>';

export const notice = (message, error = false) => message
  ? '<p class="notice' + (error ? ' error' : '') + '" role="' + (error ? 'alert' : 'status') + '">' + escape(message) + '</p>' : '';

export function connection({ clinic, attempted, csrf, webhook }) {
  const source = { ...clinic, ...attempted };
  const type = clinic?.crm_tipo ?? (source.crm_tipo === 'ghl' ? 'ghl' : 'kommo');
  const identity = clinic
    ? '<div class="account"><span>Conta CRM</span><strong>' + escape(clinic.crm_account_id) + '</strong>' +
      (clinic.kommo_conta_id ? '<span>ID numérico ' + escape(clinic.kommo_conta_id) + '</span>' : '') + '</div>'
    : '<div class="fields"><div class="field"><label for="crm_tipo">CRM</label><select id="crm_tipo" name="crm_tipo">' +
      '<option value="kommo"' + (type === 'kommo' ? ' selected' : '') + '>Kommo</option>' +
      '<option value="ghl"' + (type === 'ghl' ? ' selected' : '') + '>GoHighLevel</option></select></div>' +
      input(source, 'crm_account_id', 'Subdomínio ou Location ID', 'text', ' required') +
      '<div data-kommo>' + input(source, 'kommo_conta_id', 'ID numérico da conta Kommo') + '</div></div>';
  const webhookPanel = clinic ? '<section class="card webhook">' + heading('Webhook da clínica') +
    (webhook
      ? '<div class="copy-row"><code id="webhook-value" data-webhook="' + escape(webhook) + '">' + escape(webhook) +
        '</code><button class="secondary" type="button" data-copy>Copiar Link</button></div>' +
        '<span id="copy-status" class="status" role="status"></span>'
      : '<p>Salve um segredo para exibir o link completo. Se ainda tiver o segredo atual, insira o mesmo valor para preservar o webhook já configurado.</p>') +
    '</section>' : '';
  const url = adminUrl(clinic?.id, 'conexao');
  return webhookPanel + '<form class="card form-card" method="post" action="' + escape(url) + '">' +
    heading(clinic ? 'Dados da conexão' : 'Cadastrar clínica', clinic ? '' :
      'Cadastre a conta do CRM e a agenda para liberar as demais abas.') +
    hidden('_csrf', csrf) + (clinic ? hidden('versao', attempted?.versao ?? clinic.versao) : '') +
    input(source, 'nome_clinica', 'Nome da clínica', 'text', ' required maxlength="120"') + identity +
    '<div class="fields">' +
    input(source, 'crm_token', clinic ? 'Novo token CRM (opcional)' : 'Token CRM', 'password',
      ' autocomplete="new-password"' + (clinic ? '' : ' required')) +
    (!clinic || type === 'kommo' ? '<div data-kommo>' + input(source, 'webhook_token',
      clinic ? 'Segredo do webhook Kommo (opcional)' : 'Segredo do webhook Kommo', 'password',
      ' autocomplete="new-password" minlength="32" maxlength="128"') +
      '<small>Use de 32 a 128 caracteres URL-safe.</small></div>' : '') +
    input(source, 'funil_id', 'ID do funil', 'text', ' required') +
    input(source, 'etapa_agendamento_id', 'ID da etapa de agendamento', 'text', ' required') +
    input(source, 'responsavel_id', 'ID do responsável pelo transbordo', 'text', ' required') +
    input(source, 'agendamento_url', 'URL de agendamento', 'url', ' required') + '</div>' +
    '<footer class="form-footer"><button>' + (clinic ? 'Salvar conexão' : 'Cadastrar clínica') + '</button></footer></form>';
}

export function training({ clinic, attempted, csrf }) {
  const labels = { regras_negocio: 'Regras de negócio', quebra_objecoes: 'Quebra de objeções', faq: 'FAQ' };
  return '<form class="card form-card" method="post" action="' + escape(adminUrl(clinic.id, 'treinamento')) + '">' +
    heading('Treinamento & Prompts', 'Use blocos de respostas aprovadas para definir as frases que podem ser enviadas aos leads.') +
    hidden('_csrf', csrf) + hidden('versao', attempted?.versao ?? clinic.versao) +
    trainingFields.map(name => '<div class="field"><label for="' + name + '">' + labels[name] +
      '</label><textarea id="' + name + '" name="' + name + '" spellcheck="false">\n' +
      escape(attempted?.[name] ?? clinic[name]) + '</textarea></div>').join('') +
    '<details><summary>Formato de uma resposta aprovada</summary><pre>&lt;!-- respostas:sdr --&gt;\n' +
    'horarios | Atendemos de segunda a sexta.\n&lt;!-- fim:sdr --&gt;</pre></details>' +
    '<footer class="form-footer"><button>Salvar treinamento</button></footer></form>';
}

export function library({ clinic, csrf, docs, selected }) {
  const url = adminUrl(clinic.id, 'arquivos');
  const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Fortaleza' });
  const list = docs.map(doc => '<li class="file-row"><div class="file-meta"><span class="file-type">' +
    escape(doc.formato.toUpperCase()) + '</span><div><strong>' + escape(doc.nome) + '</strong><small>' +
    escape(date.format(new Date(doc.enviado_em))) + '</small></div></div><div class="file-actions">' +
    '<a class="secondary button" href="' + escape(url + '&arquivo=' + doc.id) + '#conteudo-arquivo">Visualizar</a>' +
    '<form method="post" action="' + escape(adminUrl(clinic.id, undefined, 'arquivos/excluir')) +
    '" data-confirm="Excluir este documento da base desta clínica?">' + hidden('_csrf', csrf) + hidden('arquivo', doc.id) +
    '<button type="submit" class="danger">Excluir</button></form></div></li>').join('');
  return '<section class="card">' + heading('Arquivos da clínica', 'PDF, DOCX, TXT e CSV. Até 5 MB por envio.') +
    '<form method="post" enctype="multipart/form-data" action="' + escape(adminUrl(clinic.id, undefined, 'arquivos')) + '">' +
    hidden('_csrf', csrf) + '<label class="drop" for="arquivo" data-drop><strong>Arraste um arquivo aqui</strong>' +
    '<span>ou selecione no seu dispositivo</span><input id="arquivo" name="arquivo" type="file" accept=".pdf,.docx,.txt,.csv" required>' +
    '<span data-filename></span></label><footer class="form-footer"><button>Enviar arquivo</button></footer></form></section>' +
    '<section class="card">' + heading('Biblioteca') +
    (list ? '<ul class="file-list">' + list + '</ul>' : '<p class="muted">Nenhum documento nesta clínica.</p>') + '</section>' +
    (selected ? '<section class="card" id="conteudo-arquivo" tabindex="-1">' + heading(selected.nome, 'Texto extraído') +
      '<pre class="document">' + escape(selected.conteudo) + '</pre></section>' : '');
}

export function tester(clinic, csrf) {
  return '<section class="card chat">' + heading('Simulador de atendimento', 'As mensagens deste teste não são enviadas ao CRM.') +
    '<div class="chat-log" data-chat-log role="log" aria-label="Conversa de teste"><p class="muted" data-empty>' +
    'Envie uma mensagem para iniciar o teste.</p></div><form data-simulator action="' +
    escape(adminUrl(clinic.id, undefined, 'simular')) + '">' + hidden('_csrf', csrf) +
    '<div class="chat-options"><label class="toggle"><input type="checkbox" name="offline" checked> Simulação sem IA</label>' +
    '<button class="secondary" type="button" data-reset>Limpar conversa</button></div>' +
    '<label for="mensagem">Mensagem do lead</label><div class="composer"><textarea id="mensagem" name="mensagem" ' +
    'placeholder="Ex.: Quais são os horários?" rows="2" maxlength="1000" required></textarea><button>Enviar</button></div>' +
    '<p class="status" data-chat-status role="status"></p></form><noscript>Ative o JavaScript para usar o simulador.</noscript></section>';
}
