import { minimumPasswordLength } from './accounts.js';
import { contactFields, professionalFields, serviceFields, maxRows, maxObservations } from './clinic-data.js';
import { trainingFields } from './clinics.js';

export const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

export const hidden = (name, value) => '<input type="hidden" name="' + escape(name) + '" value="' + escape(value) + '">';

export const tabs = {
  conexao: 'Conexão & CRM', dados: 'Informações da Clínica', treinamento: 'Treinamento & Prompts',
  arquivos: 'Arquivos (Base de Conhecimento)', feedback: 'Feedbacks & Aprendizado', teste: 'Testar Robô'
};

export function adminUrl(clinicId, tab, path = 'treinar') {
  const query = new URLSearchParams();
  if (clinicId) query.set('clinica', clinicId);
  if (tab) query.set('aba', tab);
  return '/admin/' + path + (query.size ? '?' + query : '');
}

const names = { kommo: 'Kommo', ghl: 'GoHighLevel' };
const initials = name => name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0]).join('').toUpperCase();

export function layout({ clinics, current, active, csrf, content, title: pageTitle, operations = false, member = false }) {
  const items = clinics.map(row => {
    const href = adminUrl(row.id, operations ? undefined : active, operations ? 'operacao' : 'treinar');
    return '<a class="clinic" data-clinic href="' + escape(href) + '"' + (row.id === current?.id ? ' aria-current="page"' : '') +
      '><span class="avatar" aria-hidden="true">' + escape(initials(row.nome_clinica)) +
      '</span><span class="clinic-name">' + escape(row.nome_clinica) + '<small>' + escape(names[row.crm_tipo] ?? 'Sem CRM') +
      ' <span class="clinic-status' + (row.ativo ? ' online' : '') + '">' +
      (row.crm_tipo ? (row.ativo ? 'Ativa' : 'Inativa') : 'Em configuração') + '</span></small></span></a>';
  }).join('');
  const side = '<aside class="sidebar"><a class="brand" href="/admin/treinar"><span class="mark" aria-hidden="true">+</span>' +
    '<span>Robô CRC<small>Painel administrativo</small></span></a>' +
    '<div class="side-tools">' + (member ? '' : '<a class="new" href="/admin/treinar">+ Nova Clínica</a>') +
    '<a class="side-link simulator-link" href="' + escape(adminUrl(current?.id, 'teste')) + '"' +
    (active === 'teste' ? ' aria-current="page"' : '') + '>Simular atendimento</a>' +
    '<label class="sr-only" for="clinica-busca">Buscar clínica</label>' +
    '<input id="clinica-busca" type="search" placeholder="Buscar clínica…" autocomplete="off"></div>' +
    '<nav class="clinic-list" aria-label="Clínicas">' + (items || '<p>Nenhuma clínica cadastrada.</p>') +
    '<p data-no-match role="status" hidden>Nenhuma clínica encontrada.</p></nav>' +
    '<div class="side-footer">' + (member ? '' : '<a class="side-link" href="/admin/contas">Contas e acessos</a>' +
    '<a class="side-link" href="' + escape(adminUrl(current?.id, undefined, operations ? 'treinar' : 'operacao')) + '">' +
    (operations ? 'Voltar à configuração' : 'Operação da fila') +
    '</a>') + '<form action="/admin/sair" method="post">' + hidden('_csrf', csrf) +
    '<button class="logout" type="submit">Sair</button></form></div></aside>';
  const title = pageTitle ?? (operations ? 'Operação da fila' : current?.nome_clinica ??
    (active === 'teste' ? 'Simular atendimento' : member ? 'Minha clínica' : 'Nova clínica'));
  const navigation = !operations && current ? '<nav class="tabs" aria-label="Seções da clínica">' +
    Object.entries(tabs).filter(([value]) => !member || value !== 'conexao').map(([value, label]) =>
      '<a href="' + escape(adminUrl(current.id, value)) + '"' + (value === active ? ' aria-current="page"' : '') +
      '>' + escape(label) + '</a>'
    ).join('') + '</nav>' : '';
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(title) +
    ' · Robô CRC</title><link rel="stylesheet" href="/admin/assets/panel.css">' +
    '<script defer src="/admin/assets/panel.js"></script></head><body>' + side +
    '<main id="conteudo"><div class="shell"><header class="page-heading"><h1>' + escape(title) + '</h1>' +
    (current ? '<span class="provider">' + escape(names[current.crm_tipo] ?? 'Sem CRM') + '</span>' : '') +
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

export function createClinicView({ attempted, csrf }) {
  return '<form class="card form-card" method="post" action="/admin/treinar">' +
    heading('Criar clínica', 'Informe o nome para abrir a pasta da clínica.') + hidden('_csrf', csrf) +
    input(attempted ?? {}, 'nome_clinica', 'Nome da clínica', 'text', ' required maxlength="120"') +
    '<footer class="form-footer"><button>Criar clínica</button></footer></form>';
}

export function connection({ clinic, attempted, csrf, webhook }) {
  const connected = Boolean(clinic.crm_tipo);
  const source = { ...clinic, ...attempted };
  const type = clinic?.crm_tipo ?? (source.crm_tipo === 'ghl' ? 'ghl' : 'kommo');
  const identity = connected
    ? '<div class="account"><span>Conta CRM</span><strong>' + escape(clinic.crm_account_id) + '</strong>' +
      (clinic.kommo_conta_id ? '<span>ID numérico ' + escape(clinic.kommo_conta_id) + '</span>' : '') + '</div>'
    : '<div class="fields"><div class="field"><label for="crm_tipo">CRM</label><select id="crm_tipo" name="crm_tipo">' +
      '<option value="kommo"' + (type === 'kommo' ? ' selected' : '') + '>Kommo</option>' +
      '<option value="ghl"' + (type === 'ghl' ? ' selected' : '') + '>GoHighLevel</option></select></div>' +
      input(source, 'crm_account_id', 'Subdomínio ou Location ID', 'text', ' required') +
      '<div data-kommo>' + input(source, 'kommo_conta_id', 'ID numérico da conta Kommo') + '</div></div>';
  const webhookPanel = connected ? '<section class="card webhook">' + heading('Webhook da clínica') +
    (webhook
      ? '<div class="copy-row"><code id="webhook-value" data-webhook="' + escape(webhook) + '">' + escape(webhook) +
        '</code><button class="secondary" type="button" data-copy>Copiar Link</button></div>' +
        '<span id="copy-status" class="status" role="status"></span>'
      : '<p>Salve um segredo para exibir o link completo. Se ainda tiver o segredo atual, insira o mesmo valor para preservar o webhook já configurado.</p>') +
    '</section>' : '';
  const url = escape(adminUrl(clinic.id, 'conexao'));
  const version = hidden('versao', attempted?.versao ?? clinic.versao);
  const name = input(source, 'nome_clinica', 'Nome da clínica', 'text', ' required maxlength="120"');
  const draftSettings = connected ? '' : '<form class="card form-card" method="post" action="' + url + '">' +
    heading('Nome da clínica') + hidden('_csrf', csrf) + version + hidden('configuracao', 'rascunho') + name +
    '<footer class="form-footer"><button>Salvar nome</button></footer></form>';
  return webhookPanel + draftSettings + '<form class="card form-card" method="post" action="' + url + '">' +
    heading(connected ? 'Dados da conexão' : 'Conectar CRM', connected ? '' :
      'Preencha estes campos quando quiser habilitar o atendimento pelo CRM.') +
    hidden('_csrf', csrf) + version + (connected ? name : hidden('nome_clinica', clinic.nome_clinica)) + identity +
    '<div class="fields">' +
    input(source, 'crm_token', connected ? 'Novo token CRM (opcional)' : 'Token CRM', 'password',
      ' autocomplete="new-password"' + (connected ? '' : ' required')) +
    (!connected || type === 'kommo' ? '<div data-kommo>' + input(source, 'webhook_token',
      connected ? 'Segredo do webhook Kommo (opcional)' : 'Segredo do webhook Kommo', 'password',
      ' autocomplete="new-password" minlength="32" maxlength="128"') +
      '<small>Use de 32 a 128 caracteres URL-safe.</small></div>' : '') +
    input(source, 'funil_id', 'ID do funil', 'text', ' required') +
    input(source, 'etapa_agendamento_id', 'ID da etapa de agendamento', 'text', ' required') +
    input(source, 'responsavel_id', 'ID do responsável pelo transbordo', 'text', ' required') + '</div>' +
    (connected ? '<div class="field clinic-toggle"><label for="ativo">Status do atendimento</label>' +
      '<select id="ativo" name="ativo"><option value="sim"' +
      (source.ativo === true || source.ativo === 'sim' ? ' selected' : '') + '>Ativa</option><option value="nao"' +
      (source.ativo === false || source.ativo === 'nao' ? ' selected' : '') +
      '>Inativa</option></select><small>Uma clínica inativa deixa de receber novos eventos para o robô.</small></div>' : '') +
    '<footer class="form-footer"><button>' + (connected ? 'Salvar conexão' : 'Conectar CRM') + '</button></footer></form>';
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

const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Fortaleza' });

export function library({ clinic, csrf, docs, selected, tab }) {
  const url = adminUrl(clinic.id, tab);
  const list = docs.map(doc => '<li class="file-row"><div class="file-meta"><span class="file-type">' +
    escape(doc.formato.toUpperCase()) + '</span><div><strong>' + escape(doc.nome) + '</strong><small>' +
    escape(date.format(new Date(doc.enviado_em))) + '</small></div></div><div class="file-actions">' +
    '<a class="secondary button" href="' + escape(url + '&arquivo=' + doc.id) + '#conteudo-arquivo">Visualizar</a>' +
    '<form method="post" action="' + escape(adminUrl(clinic.id, tab, 'arquivos/excluir')) +
    '" data-confirm="Excluir este documento da base desta clínica?">' + hidden('_csrf', csrf) + hidden('arquivo', doc.id) +
    '<button type="submit" class="danger">Excluir</button></form></div></li>').join('');
  return '<section class="card">' + heading('Arquivos da clínica', 'PDF, DOCX, TXT e CSV. Até 5 MB por envio.') +
    '<form method="post" enctype="multipart/form-data" action="' + escape(adminUrl(clinic.id, tab, 'arquivos')) + '">' +
    hidden('_csrf', csrf) + '<label class="drop" for="arquivo" data-drop><strong>Arraste um arquivo aqui</strong>' +
    '<span>ou selecione no seu dispositivo</span><input id="arquivo" name="arquivo" type="file" accept=".pdf,.docx,.txt,.csv" required>' +
    '<span data-filename></span></label><footer class="form-footer"><button>Enviar arquivo</button></footer></form></section>' +
    '<section class="card">' + heading('Biblioteca') +
    (list ? '<ul class="file-list">' + list + '</ul>' : '<p class="muted">Nenhum documento nesta clínica.</p>') + '</section>' +
    (selected ? '<section class="card" id="conteudo-arquivo" tabindex="-1">' + heading(selected.nome, 'Texto extraído') +
      '<pre class="document">' + escape(selected.conteudo) + '</pre></section>' : '');
}

export function clinicDataView({ clinic, draft, csrf, version }) {
  const data = draft ?? clinic.dados_publicos ?? {};
  function rows(items, prefix, title, rowName, fields) {
    const row = values => '<fieldset class="clinic-data-row" data-data-row><legend>' + rowName + '</legend>' +
      '<div class="fields">' + fields.map(([key, label, max]) =>
        '<label class="field">' + escape(label) + '<input name="' + prefix + '_' + key +
        '" maxlength="' + max + '" value="' + escape(values[key]) + '"></label>').join('') +
      '</div><button type="button" class="danger" data-remove-data>Remover ' + rowName.toLowerCase() + '</button></fieldset>';
    return '<section class="card" data-data-group data-max-rows="' + maxRows + '">' + heading(title) +
      '<div data-data-rows>' + (items?.length ? items : [{}]).map(row).join('') + '</div>' +
      '<template>' + row({}) + '</template><button type="button" class="secondary" data-add-data>+ Adicionar ' +
      rowName.toLowerCase() + '</button><span class="status" role="status" data-data-status></span></section>';
  }
  const contact = data.contato ?? {};
  return '<form action="' + escape(adminUrl(clinic.id, undefined, 'dados')) + '" method="post">' +
    hidden('_csrf', csrf) + hidden('versao', version ?? clinic.versao) +
    '<section class="card">' + heading('Localização e contato') + '<div class="fields">' +
    contactFields.map(([key, label, max]) => input(contact, key, label, key === 'maps_url' ? 'url' :
      key === 'recepcao' ? 'tel' : 'text', ' maxlength="' + max + '"')).join('') + '</div>' +
    (clinic.dados_publicos?.contato?.maps_url
      ? '<p><a target="_blank" rel="noopener noreferrer" href="' +
        escape(clinic.dados_publicos.contato.maps_url) + '">Abrir endereço no Google Maps</a></p>' : '') +
    '</section>' + rows(data.profissionais, 'prof', 'Corpo clínico', 'Profissional', professionalFields) +
    rows(data.servicos, 'serv', 'Serviços e preços', 'Serviço', serviceFields) +
    '<section class="card">' + heading('Observações gerais da clínica') +
    '<label for="observacoes">Diferenciais, preparo de exames e regras da unidade</label>' +
    '<p class="muted" id="observacoes-ajuda">Escreva as orientações que podem ser compartilhadas com pacientes, uma por linha, com até 320 caracteres por orientação.</p>' +
    '<textarea id="observacoes" name="observacoes" rows="6" maxlength="' + maxObservations +
    '" aria-describedby="observacoes-ajuda">' + escape(data.observacoes) + '</textarea></section>' +
    '<div class="form-footer"><button>Salvar informações</button></div></form>';
}

export function simulationClinicPicker(clinics, current) {
  if (!clinics.length) return '';
  const options = clinics.map(clinic => '<option value="' + escape(clinic.id) + '"' +
    (clinic.id === current?.id ? ' selected' : '') + '>' + escape(clinic.nome_clinica) + '</option>').join('');
  return '<section class="card"><form class="simulation-picker" method="get" action="/admin/treinar">' +
    hidden('aba', 'teste') + '<label for="simulador-clinica">Usar uma clínica cadastrada</label>' +
    '<div class="copy-row"><select id="simulador-clinica" name="clinica" required>' +
    '<option value=""' + (current ? '' : ' selected') + ' disabled>Selecione uma clínica</option>' +
    options + '</select><button>Carregar simulador</button></div></form></section>';
}

export function tester(clinic, csrf) {
  const action = clinic ? adminUrl(clinic.id, undefined, 'simular') : '/admin/simular?modo=rapido';
  return '<section class="card chat">' + heading('Simulador de atendimento', clinic
    ? 'As mensagens deste teste não são enviadas ao CRM. Ative a IA para testar a interpretação dos feedbacks.'
    : 'Informe o nome da clínica para testar com respostas genéricas, sem conectar um CRM.') +
    (clinic ? '<p><a href="/admin/treinar?aba=teste&amp;modo=rapido">Simular só com o nome</a></p>' : '') +
    '<div class="chat-log" data-chat-log role="log" aria-label="Conversa de teste"><p class="muted" data-empty>' +
    'Envie uma mensagem para iniciar o teste.</p></div><form data-simulator action="' +
    escape(action) + '">' + hidden('_csrf', csrf) +
    (clinic ? '' : input({}, 'nome_clinica', 'Nome da clínica', 'text', ' required maxlength="120"')) +
    '<div class="chat-options"><label class="toggle"><input type="checkbox" name="offline" checked> Simulação sem IA</label>' +
    '<button class="secondary" type="button" data-reset>Limpar conversa</button></div>' +
    '<label for="mensagem">Mensagem do lead</label><div class="composer"><textarea id="mensagem" name="mensagem" ' +
    'placeholder="Ex.: Quais são os horários?" rows="2" maxlength="1000" required></textarea><button>Enviar</button></div>' +
    '<p class="status" data-chat-status role="status"></p></form><noscript>Ative o JavaScript para usar o simulador.</noscript></section>';
}

export function feedbackView({ clinic, attempted, csrf, corrections }) {
  const items = [...corrections].reverse().map(row =>
    '<li class="feedback-row"><div><time datetime="' + escape(new Date(row.criado_em).toISOString()) + '">' +
    escape(date.format(new Date(row.criado_em))) + '</time><p>' + escape(row.conteudo) + '</p></div>' +
    '<form method="post" action="' + escape(adminUrl(clinic.id, undefined, 'feedback/excluir')) +
    '" data-confirm="Excluir este feedback do treinamento da clínica?">' +
    hidden('_csrf', csrf) + hidden('feedback', row.id) + '<button class="danger">Excluir</button></form></li>'
  ).join('');
  return '<form class="card form-card" method="post" action="' +
    escape(adminUrl(clinic.id, undefined, 'feedback')) + '">' + hidden('_csrf', csrf) +
    heading('Adicionar feedback', 'Oriente como o robô deve escolher as respostas desta clínica. Para liberar uma nova frase, publique-a em Treinamento & Prompts.') +
    '<div class="field"><label for="feedback-conteudo">Correção ou exemplo de resposta</label>' +
    '<textarea id="feedback-conteudo" name="conteudo" maxlength="1600" rows="4" required ' +
    'placeholder="Ex.: Ao perguntarem o preço, acolha a dúvida antes de informar um valor aprovado.">' +
    escape(attempted?.conteudo) + '</textarea></div>' +
    '<footer class="form-footer"><small>' + corrections.length + ' de 16 feedbacks</small><button>Salvar feedback</button></footer></form>' +
    '<section class="card">' + heading('Feedbacks da clínica') +
    (items ? '<ul class="file-list">' + items + '</ul>' : '<p class="muted">Nenhum feedback cadastrado.</p>') + '</section>';
}


function accountPage(title, content) {
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(title) + ' · Robô CRC</title>' +
    '<link rel="stylesheet" href="/admin/assets/panel.css"><script defer src="/admin/assets/panel.js"></script></head>' +
    '<body class="login-page"><main class="login-main">' +
    '<div class="login-identity"><span class="mark" aria-hidden="true">+</span>Robô CRC</div>' +
    '<section class="card login-card"><h1>' + escape(title) + '</h1>' + content + '</section></main></body></html>';
}

const emailField = input({}, 'email', 'E-mail', 'email', ' autocomplete="username" maxlength="254" required');
export function loginPage(message = '', success = '') {
  return accountPage('Entrar no painel',
    '<p class="muted">Gerencie as clínicas e seus atendimentos.</p>' + notice(message, true) + notice(success) +
    '<form action="/admin/login" method="post">' + emailField +
    input({}, 'senha', 'Senha', 'password', ' autocomplete="current-password" maxlength="1024" required') +
    '<button type="submit">Entrar</button></form><p><a href="/admin/cadastrar">Criar conta</a></p>');
}

export function signupPage(message = '', requested = false) {
  return accountPage('Criar conta',
    (requested ? notice('Solicitação recebida. O administrador enviará ao seu e-mail o link para definir a senha e ativar o acesso.') :
      '<p class="muted">Informe seu e-mail para solicitar acesso a uma clínica.</p>' + notice(message, true) +
      '<form action="/admin/cadastrar" method="post">' + emailField + '<button>Solicitar acesso</button></form>') +
    '<p><a href="/admin/login">Voltar ao login</a></p>');
}

export function activationPage(message = '', token) {
  return accountPage('Ativar conta',
    '<p class="muted">Defina a senha da sua conta. Use de ' + minimumPasswordLength + ' a 256 caracteres.</p>' + notice(message, true) +
    '<form action="/admin/ativar" method="post" data-activation>' + hidden('convite', typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? token : '') +
    input({}, 'senha', 'Senha', 'password', ' autocomplete="new-password" minlength="' + minimumPasswordLength + '" maxlength="256" required') +
    '<button>Ativar conta</button></form><p><a href="/admin/login">Voltar ao login</a></p>');
}

export function accountsView({ accounts, clinics, csrf, invitation }) {
  const options = clinics.map(clinic => '<option value="' + escape(clinic.id) + '">' +
    escape(clinic.nome_clinica) + '</option>').join('');
  const rows = accounts.map(account => {
    const clinic = clinics.find(row => row.id === account.clinica_id);
    return '<li class="feedback-row"><div><strong>' + escape(account.email) + '</strong><small class="status">' +
      escape(account.active ? 'Ativa' : account.invited ? 'Convite pendente' : 'Aguardando aprovação') +
      (clinic ? ' · ' + escape(clinic.nome_clinica) : '') + '</small></div>' +
      (account.active || !clinics.length ? '' : '<form method="post" action="/admin/contas/convidar">' +
        hidden('_csrf', csrf) + hidden('conta', account.id) +
        '<label for="clinica-' + escape(account.id) + '">Clínica</label><select id="clinica-' +
        escape(account.id) + '" name="clinica" required>' + options + '</select><button>' + (account.invited ? 'Gerar novo link' : 'Gerar link de ativação') + '</button></form>') +
      '<form method="post" action="/admin/contas/revogar" data-confirm="Revogar o acesso desta conta?">' +
      hidden('_csrf', csrf) + hidden('conta', account.id) + '<button class="danger">' +
      (account.active ? 'Revogar acesso' : 'Remover solicitação') + '</button></form></li>';
  }).join('');
  return (invitation ? '<section class="card webhook">' +
    heading('Link de ativação', 'Envie este link em particular para o e-mail indicado. Ele expira em 48 horas e funciona uma vez.') +
    '<label for="activation-link">' + escape(invitation.email) + '</label><div class="copy-row">' +
    '<input id="activation-link" readonly value="' + escape(invitation.path) + '">' +
    '<button class="secondary" type="button" data-copy-invitation>Copiar link</button></div>' +
    '<span class="status" data-invitation-status role="status"></span></section>' : '') +
    '<section class="card">' + heading('Solicitações e contas', 'Escolha uma clínica para liberar o acesso ao treinamento, aos arquivos e ao simulador.') +
    (rows ? '<ul class="file-list">' + rows + '</ul>' : '<p class="muted">Nenhuma solicitação recebida.</p>') + '</section>';
}
