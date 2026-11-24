import { createHmac } from 'node:crypto';
import express from 'express';
import { equalSecret } from './webhooks.js';
import { ClinicError, trainingFields } from './clinics.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

const hidden = (name, value) => '<input type="hidden" name="' + escape(name) + '" value="' + escape(value) + '">';

function page(title, body) {
  return '<!doctype html><html lang="pt-BR"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escape(title) + ' · SDR</title><style>' +
    'body{margin:0;background:#f4f6f7;color:#172524;font:16px system-ui,sans-serif}' +
    'main{max-width:960px;margin:3rem auto;padding:0 1.25rem}nav{display:flex;gap:1rem;flex-wrap:wrap}' +
    'a{color:#125c50}a[aria-current=page]{font-weight:700}.card{background:white;border:1px solid #d3dddb;border-radius:.8rem;padding:1.25rem;margin:1rem 0}' +
    'label{display:block;margin-top:.8rem}.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:0 1rem}' +
    'input:not([type=hidden]),select{box-sizing:border-box;width:100%;padding:.55rem;border:1px solid #879895;border-radius:.35rem;font:inherit}' +
    'textarea{display:block;width:100%;min-height:12rem;padding:.75rem;box-sizing:border-box;border:1px solid #879895;border-radius:.35rem;font:15px/1.6 monospace;margin:.75rem 0}' +
    'button{color:white;background:#125c50;border:0;border-radius:.4rem;padding:.65rem 1rem;font:inherit;cursor:pointer;margin:.25rem .35rem .25rem 0}' +
    'button.secondary{background:#4a5957}code{overflow-wrap:anywhere}.notice{border-left:4px solid #125c50;padding:.65rem 1rem;background:#e5f2f0}' +
    ':focus-visible{outline:3px solid #a35109;outline-offset:3px}</style>' +
    '<main><nav aria-label="Administração"><a href="/admin/treinar">Clínicas e treinamento</a>' +
    '<a href="/admin/operacao">Operação</a></nav><h1>' + escape(title) + '</h1>' + body + '</main></html>';
}

export function admin(config, clinics, store) {
  const router = express.Router();
  const csrf = createHmac('sha256', config.adminToken).update('sdr-admin-form-v1').digest('hex');
  router.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer'
    });
    const [scheme, credential] = (req.get('Authorization') ?? '').split(' ');
    let token = scheme?.toLowerCase() === 'bearer' ? credential : null;
    if (scheme?.toLowerCase() === 'basic' && credential) {
      const decoded = Buffer.from(credential, 'base64').toString('utf8');
      if (decoded.startsWith('admin:')) token = decoded.slice(6);
    }
    if (!equalSecret(token, config.adminToken)) {
      return res.set('WWW-Authenticate', 'Basic realm="SDR", charset="UTF-8"').sendStatus(401);
    }
    next();
  });
  const form = express.urlencoded({ extended: false, limit: '256kb', parameterLimit: 24, inflate: false });
  function protect(req, res, next) {
    if (req.get('Sec-Fetch-Site') === 'cross-site' || !equalSecret(req.body?._csrf, csrf)) {
      return res.sendStatus(403);
    }
    next();
  }

  function links(clinicId, destination) {
    return '/admin/' + destination + (clinicId ? '?clinica=' + encodeURIComponent(clinicId) : '');
  }

  async function navigation(destination, current, includeNew = false) {
    const list = await clinics.list();
    const items = list.map(clinic =>
      '<a ' + (clinic.id === current ? 'aria-current="page" ' : '') + 'href="' +
      links(clinic.id, destination) + '">' + escape(clinic.nome_clinica) + ' · ' + escape(clinic.crm_tipo) + '</a>'
    ).join('');
    return '<nav aria-label="Clínicas">' +
      (includeNew ? '<a href="/admin/treinar">Nova clínica</a>' : '') + items + '</nav>';
  }

  function input(source, name, label, type = 'text', attributes = '') {
    const value = type === 'password' ? '' : source[name];
    return '<label for="' + name + '">' + escape(label) + '</label><input id="' + name +
      '" name="' + name + '" type="' + type + '" value="' + escape(value) + '"' + attributes + '>';
  }

  async function renderTraining(res, clinic, message = '', status = 200, attempted = {}) {
    const source = { ...clinics.templates, ...clinic, ...attempted };
    const type = clinic?.crm_tipo ?? (source.crm_tipo === 'ghl' ? 'ghl' : 'kommo');
    const notice = message ? '<p class="notice" role="status">' + escape(message) + '</p>' : '';
    const identity = clinic
      ? '<p>CRM <strong>' + escape(clinic.crm_tipo) + '</strong> · Conta <code>' +
        escape(clinic.crm_account_id) + '</code>' +
        (clinic.kommo_conta_id ? ' · ID numérico <code>' + escape(clinic.kommo_conta_id) + '</code>' : '') + '</p>'
      : '<div class="fields"><div><label for="crm_tipo">CRM</label><select id="crm_tipo" name="crm_tipo">' +
        '<option value="kommo"' + (type === 'kommo' ? ' selected' : '') + '>Kommo</option>' +
        '<option value="ghl"' + (type === 'ghl' ? ' selected' : '') + '>GoHighLevel</option></select></div><div>' +
        input(source, 'crm_account_id', 'Subdomínio do Kommo ou Location ID do GoHighLevel', 'text', ' required') +
        '</div><div>' + input(source, 'kommo_conta_id', 'ID numérico da conta (somente Kommo)') + '</div></div>';
    const security = '<div>' +
      input(source, 'crm_token', clinic ? 'Novo token CRM (opcional)' : 'Token CRM', 'password',
        ' autocomplete="new-password"' + (clinic ? '' : ' required')) + '</div>' +
      (!clinic || clinic.crm_tipo === 'kommo'
        ? '<div>' + input(source, 'webhook_token',
          clinic ? 'Novo segredo do webhook Kommo (opcional)' : 'Segredo do webhook (somente Kommo)', 'password',
          ' autocomplete="new-password" minlength="32" maxlength="128"') +
          '<small>Use 32 a 128 caracteres com letras, números, hífen ou sublinhado. Guarde o valor para configurar o webhook.</small></div>'
        : '');
    const labels = { regras_negocio: 'Regras de negócio', quebra_objecoes: 'Quebra de objeções', faq: 'FAQ' };
    const training = trainingFields.map(name =>
      '<label for="' + name + '">' + labels[name] + '</label><textarea name="' + name + '" id="' + name +
      '" spellcheck="false">\n' + escape(source[name]) + '</textarea>'
    ).join('');
    const route = clinic ? '<div class="card"><p>Webhook desta clínica</p><code>/webhook/' +
      escape(clinic.crm_tipo) + '/' + escape(clinic.id) +
      (clinic.crm_tipo === 'kommo' ? '?token=SEU_SEGREDO' : '') + '</code><p>Use o domínio HTTPS do servidor.</p>' +
      '<a href="' + links(clinic.id, 'operacao') + '">Ver operação desta clínica</a></div>' : '';
    const editor = '<form class="card" method="post" action="' + links(clinic?.id, 'treinar') + '">' +
      hidden('_csrf', csrf) + (clinic ? hidden('versao', attempted.versao ?? clinic.versao) : '') +
      '<h2>' + (clinic ? 'Editar ' + escape(clinic.nome_clinica) : 'Cadastrar clínica') + '</h2>' +
      input(source, 'nome_clinica', 'Nome da clínica', 'text', ' required maxlength="120"') + identity +
      '<div class="fields">' + security + '<div>' + input(source, 'funil_id', 'ID do funil', 'text', ' required') +
      '</div><div>' + input(source, 'etapa_agendamento_id', 'ID da etapa de agendamento', 'text', ' required') +
      '</div><div>' + input(source, 'responsavel_id', 'ID do responsável pelo transbordo', 'text', ' required') +
      '</div></div>' + input(source, 'agendamento_url', 'URL de agendamento', 'url', ' required') +
      '<h3>Treinamento</h3>' + training + '<button>Salvar clínica</button></form>';
    res.status(status).type('html').send(page('Clínicas e treinamento',
      await navigation('treinar', clinic?.id, true) + notice + route + editor));
  }

  async function selected(req, res, next) {
    if (req.query.clinica === undefined) return next();
    const clinic = await clinics.get(req.query.clinica);
    if (!clinic) return res.sendStatus(404);
    res.locals.clinic = clinic;
    next();
  }

  router.get('/treinar', selected, (req, res) => renderTraining(res, res.locals.clinic,
    req.query.salvo === '1' ? 'Clínica salva.' : ''));
  router.post('/treinar', form, protect, selected, async (req, res) => {
    const clinic = res.locals.clinic;
    try {
      const id = await clinics.save(req.body, clinic);
      res.redirect(303, links(id, 'treinar') + '&salvo=1');
    } catch (error) {
      if (!(error instanceof ClinicError)) throw error;
      return renderTraining(res, clinic, error.message, 422, req.body);
    }
  });

  router.get('/operacao', selected, async (req, res) => {
    const clinic = res.locals.clinic;
    const nav = await navigation('operacao', clinic?.id);
    if (!clinic) return res.type('html').send(page('Operação', nav + '<p>Selecione uma clínica.</p>'));
    const action = links(clinic.id, 'operacao');
    const [pending, paused] = await Promise.all([store.pending(clinic.id), store.pausedLeads(clinic.id)]);
    const jobs = pending.map(job => '<form class="card" action="' + action + '" method="post">' +
      hidden('_csrf', csrf) + hidden('seq', job.seq) +
      '<p><strong>Evento ' + escape(job.seq) + '</strong> · <code>' + escape(job.lead.split(':').at(-1)) + '</code><br>' +
      'Referência <code>' + escape(job.reference) + '</code><br>' +
      escape(job.state === 'uncertain' ? 'Resultado incerto' : 'Bloqueado') +
      ' · ' + escape(job.step ?? 'classificação') + ' · ' + escape(job.error) + '</p>' +
      (job.state === 'uncertain' ? '<p>Confira no CRM se a mensagem ou tarefa foi criada antes de repetir.</p>' : '') +
      '<button name="acao" value="tentar">Tentar novamente</button>' +
      '<button class="secondary" name="acao" value="descartar">Encerrar evento</button></form>').join('');
    const pauses = paused.map(({ lead }) =>
      '<form class="card" action="' + action + '" method="post">' + hidden('_csrf', csrf) +
      hidden('lead', lead) + '<p><code>' + escape(lead.split(':').at(-1)) +
      '</code></p><button name="acao" value="reativar">Reativar IA</button></form>').join('');
    res.type('html').send(page('Operação · ' + clinic.nome_clinica, nav +
      '<h2>Eventos que precisam de atenção</h2>' + (jobs || '<p>Nenhum evento pendente.</p>') +
      '<h2>Leads com a IA pausada</h2>' + (pauses || '<p>Nenhum lead pausado.</p>')));
  });

  router.post('/operacao', form, protect, selected, async (req, res) => {
    const clinic = res.locals.clinic;
    if (!clinic) return res.sendStatus(404);
    const { acao, seq, lead } = req.body;
    const applied = acao === 'reativar' && typeof lead === 'string'
      ? await store.resume(clinic.id, lead)
      : typeof seq === 'string' && /^\d{1,18}$/.test(seq) && await store.resolve(clinic.id, seq, acao);
    if (!applied) return res.status(409).type('html').send(page('Ação indisponível',
      '<p>Atualize a página de operação. Para reativar um lead, resolva a tarefa de transbordo pendente ou aguarde o processamento em andamento.</p>'));
    res.redirect(303, links(clinic.id, 'operacao'));
  });
  return router;
}
