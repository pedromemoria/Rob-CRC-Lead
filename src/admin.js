import { createHmac } from 'node:crypto';
import express from 'express';
import { equalSecret } from './webhooks.js';
import { KnowledgeError } from './knowledge.js';

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
    'textarea{display:block;width:100%;min-height:24rem;padding:.75rem;box-sizing:border-box;border:1px solid #879895;border-radius:.35rem;font:15px/1.6 monospace;margin:.75rem 0}' +
    'button{color:white;background:#125c50;border:0;border-radius:.4rem;padding:.65rem 1rem;font:inherit;cursor:pointer;margin:.25rem .35rem .25rem 0}' +
    'button.secondary{background:#4a5957}code{overflow-wrap:anywhere}.notice{border-left:4px solid #125c50;padding:.65rem 1rem;background:#e5f2f0}' +
    ':focus-visible{outline:3px solid #a35109;outline-offset:3px}</style>' +
    '<main><nav aria-label="Administração"><a href="/admin/treinar">Treinamento</a>' +
    '<a href="/admin/operacao">Operação</a></nav><h1>' + escape(title) + '</h1>' + body + '</main></html>';
}

export function admin(config, knowledge, store) {
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
  const form = express.urlencoded({ extended: false, limit: '96kb', parameterLimit: 8, inflate: false });
  function protect(req, res, next) {
    if (req.get('Sec-Fetch-Site') === 'cross-site' || !equalSecret(req.body?._csrf, csrf)) {
      return res.sendStatus(403);
    }
    next();
  }

  async function renderTraining(req, res, message = '', status = 200, attempted) {
    const files = await knowledge.files();
    const active = files.has(req.query.arquivo) ? req.query.arquivo : files.keys().next().value;
    const tabs = Array.from(files.keys(), name =>
      '<a ' + (name === active ? 'aria-current="page" ' : '') +
      'href="/admin/treinar?arquivo=' + encodeURIComponent(name) + '">' + escape(name) + '</a>'
    ).join('');
    const notice = message ? '<p class="notice" role="status">' + escape(message) + '</p>' : '';
    const editor = active
      ? '<form class="card" method="post" action="/admin/treinar?arquivo=' + encodeURIComponent(active) + '">' +
        hidden('_csrf', csrf) + hidden('revision', attempted?.revision ?? knowledge.revision(files.get(active))) +
        '<label for="texto">' + escape(active) + '</label><textarea id="texto" name="texto" spellcheck="false">\n' +
        escape(attempted?.text ?? files.get(active)) + '</textarea><button>Salvar arquivo</button></form>'
      : '<p>Adicione um arquivo .md ou .txt na pasta da base para começar.</p>';
    res.status(status).type('html').send(page('Base de conhecimento',
      '<nav aria-label="Arquivos">' + tabs + '</nav>' + notice + editor));
  }
  router.get('/treinar', (req, res) => renderTraining(req, res,
    req.query.salvo === '1' ? 'Arquivo salvo. A próxima conversa já usa esta versão.' : ''));
  router.post('/treinar', form, protect, async (req, res) => {
    try {
      await knowledge.save(req.query.arquivo, req.body.texto, req.body.revision);
      res.redirect(303, '/admin/treinar?salvo=1&arquivo=' + encodeURIComponent(req.query.arquivo));
    } catch (error) {
      if (!(error instanceof KnowledgeError)) throw error;
      return renderTraining(req, res, error.message, 422, { text: req.body.texto, revision: req.body.revision });
    }
  });
  router.get('/operacao', async (req, res) => {
    const jobs = (await store.pending()).map(job => '<form class="card" action="/admin/operacao" method="post">' +
      hidden('_csrf', csrf) + hidden('seq', job.seq) +
      '<p><strong>Evento ' + job.seq + '</strong> · <code>' + escape(job.lead) + '</code><br>' +
      'Referência <code>' + escape(job.reference) + '</code><br>' +
      escape(job.state === 'uncertain' ? 'Resultado incerto' : 'Bloqueado') +
      ' · ' + escape(job.step ?? 'classificação') + ' · ' + escape(job.error) + '</p>' +
      (job.state === 'uncertain' ? '<p>Confira no CRM se a mensagem ou tarefa foi criada antes de repetir.</p>' : '') +
      '<button name="acao" value="tentar">Tentar novamente</button>' +
      '<button class="secondary" name="acao" value="descartar">Encerrar evento</button></form>').join('');
    const pauses = (await store.pausedLeads()).map(({ lead }) =>
      '<form class="card" action="/admin/operacao" method="post">' + hidden('_csrf', csrf) +
      hidden('lead', lead) + '<p><code>' + escape(lead) +
      '</code></p><button name="acao" value="reativar">Reativar IA</button></form>').join('');
    res.type('html').send(page('Operação',
      '<h2>Eventos que precisam de atenção</h2>' + (jobs || '<p>Nenhum evento pendente.</p>') +
      '<h2>Leads com a IA pausada</h2>' + (pauses || '<p>Nenhum lead pausado.</p>')));
  });
  router.post('/operacao', form, protect, async (req, res) => {
    const { acao, seq, lead } = req.body;
    const applied = acao === 'reativar' && typeof lead === 'string'
      ? await store.resume(lead)
      : /^\d{1,14}$/.test(seq ?? '') && await store.resolve(seq, acao);
    if (!applied) return res.status(409).type('html').send(page('Ação indisponível',
      '<p>Atualize a página de operação. Para reativar um lead, resolva a tarefa de transbordo pendente ou aguarde o processamento em andamento.</p>'));
    res.redirect(303, '/admin/operacao');
  });
  return router;
}
