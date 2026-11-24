import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { equalSecret } from './webhooks.js';
import { ClinicError, clinicKnowledge, trainingFields, uuid } from './clinics.js';
import { DocumentError, extractDocument, uploadBytes } from './documents.js';
import { simulate, validHistory } from './simulator.js';
import { adminUrl, connection, escape, hidden, layout, library, notice, tabs, tester, training } from './admin-view.js';

export function admin(config, clinics, store, { documents, decide }) {
  const router = express.Router();
  const csrf = createHmac('sha256', config.adminToken).update('sdr-admin-form-v1').digest('hex');
  router.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('Sec-Fetch-Site') === 'cross-site') {
      return res.sendStatus(403);
    }
    next();
  });
  router.use('/assets', express.static(fileURLToPath(new URL('./admin-assets/', import.meta.url)), { maxAge: 0, index: false }));
  const form = express.urlencoded({ extended: false, limit: '256kb', parameterLimit: 24, inflate: false });
  const json = express.json({ limit: '64kb', inflate: false });
  const upload = multer({ storage: multer.memoryStorage(), limits: {
    fileSize: uploadBytes, files: 1, fields: 1, parts: 3, fieldSize: 1024
  } }).single('arquivo');
  let extractions = 0;

  function protect(req, res, next) {
    if (!equalSecret(req.get('X-CSRF-Token') ?? req.body?._csrf, csrf)) return res.sendStatus(403);
    next();
  }
  async function selected(req, res, next) {
    if (req.query.clinica === undefined) return next();
    const clinic = await clinics.get(req.query.clinica);
    if (!clinic) return res.sendStatus(404);
    res.locals.clinic = clinic;
    next();
  }
  function requireClinic(req, res, next) {
    if (!res.locals.clinic) return res.sendStatus(404);
    next();
  }

  async function renderPanel(req, res, { message = '', status = 200, attempted, tab = req.query.aba } = {}) {
    const clinic = res.locals.clinic;
    const active = clinic && Object.hasOwn(tabs, tab) ? tab : 'conexao';
    const rows = await clinics.list();
    let body;
    if (active === 'arquivos') {
      const file = req.query.arquivo;
      if (file !== undefined && (typeof file !== 'string' || !uuid.test(file))) return res.sendStatus(404);
      const [docs, selectedFile] = await Promise.all([documents.list(clinic.id), file ? documents.read(clinic.id, file) : null]);
      if (file && !selectedFile) return res.sendStatus(404);
      body = library({ clinic, csrf, docs, selected: selectedFile });
    } else if (active === 'treinamento') body = training({ clinic, attempted, csrf });
    else if (active === 'teste') body = tester(clinic, csrf);
    else body = connection({ clinic, attempted, csrf, webhook: clinic ? await clinics.webhookPath(clinic) : null });
    res.status(status).type('html').send(layout({
      clinics: rows, current: clinic, active, content: notice(message, status >= 400) + body
    }));
  }

  const messages = { clinic: 'Clínica salva.', training: 'Treinamento salvo.', uploaded: 'Arquivo enviado.', deleted: 'Arquivo excluído.' };
  router.get('/treinar', selected, (req, res) => renderPanel(req, res, {
    message: Object.hasOwn(messages, req.query.salvo) ? messages[req.query.salvo] : ''
  }));
  router.post('/treinar', form, protect, selected, async (req, res) => {
    const clinic = res.locals.clinic;
    const trainingOnly = clinic && req.query.aba === 'treinamento';
    if (req.query.aba && !['conexao', 'treinamento'].includes(req.query.aba)) return res.sendStatus(400);
    const fields = trainingOnly
      ? { ...clinic, versao: req.body.versao,
        ...Object.fromEntries(trainingFields.map(name => [name, req.body[name]])) }
      : { ...req.body, ...Object.fromEntries(trainingFields.map(name => [
        name, req.query.aba === 'conexao' ? (clinic ?? clinics.templates)[name] : req.body[name] ?? (clinic ?? clinics.templates)[name]
      ])) };
    try {
      const id = await clinics.save(fields, clinic);
      res.redirect(303, adminUrl(id, trainingOnly ? 'treinamento' : 'conexao') + '&salvo=' + (trainingOnly ? 'training' : 'clinic'));
    } catch (error) {
      if (!(error instanceof ClinicError)) throw error;
      return renderPanel(req, res, { message: error.message, status: 422, attempted: req.body });
    }
  });

  router.post('/arquivos', selected, requireClinic, (req, res, next) => {
    upload(req, res, error => {
      if (!error) return next();
      if (!(error instanceof multer.MulterError)) return next(error);
      renderPanel(req, res, { tab: 'arquivos', status: 422, message: 'Envie um arquivo por vez, com até 5 MB.' }).catch(next);
    });
  }, protect, async (req, res) => {
    const clinic = res.locals.clinic;
    if (extractions >= 2) return renderPanel(req, res, { tab: 'arquivos', status: 429, message: 'Há uploads em andamento. Tente novamente em instantes.' });
    extractions++;
    try {
      await documents.save(clinic.id, await extractDocument(req.file));
      res.redirect(303, adminUrl(clinic.id, 'arquivos') + '&salvo=uploaded');
    } catch (error) {
      if (!(error instanceof DocumentError)) throw error;
      return renderPanel(req, res, { tab: 'arquivos', status: 422, message: error.message });
    } finally {
      extractions--;
    }
  });

  router.post('/arquivos/excluir', form, protect, selected, requireClinic, async (req, res) => {
    const fileId = req.body.arquivo;
    const clinicId = res.locals.clinic.id;
    if (typeof fileId !== 'string' || !uuid.test(fileId) || !await documents.remove(clinicId, fileId)) {
      return res.sendStatus(404);
    }
    res.redirect(303, adminUrl(clinicId, 'arquivos') + '&salvo=deleted');
  });

  router.post('/simular', json, protect, selected, requireClinic, async (req, res) => {
    const { text, withAI } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim() || text.length > 1000 || typeof withAI !== 'boolean') {
      return res.status(422).json({ error: 'Digite uma mensagem com até 1.000 caracteres.' });
    }
    const clinic = res.locals.clinic;
    const history = validHistory(req.body.history);
    const search = [text, history.at(-1)?.inbound].filter(Boolean).join(' ');
    const references = await documents.context(clinic.id, search);
    try {
      res.json(await simulate({ clinic, text: text.trim(), history, withAI, decide,
        knowledge: { ...clinicKnowledge(clinic), references } }));
    } catch (error) {
      if (!withAI) throw error;
      const message = [401, 403, 429].includes(error.status)
        ? 'A OpenAI recusou a chamada. Confira a chave, os créditos ou os limites e use a simulação sem IA para testar.'
        : 'Não foi possível consultar a OpenAI. Tente novamente ou use a simulação sem IA.';
      res.status(502).json({ error: message });
    }
  });

  router.get('/operacao', selected, async (req, res) => {
    const clinic = res.locals.clinic;
    const rows = await clinics.list();
    if (!clinic) return res.type('html').send(layout({
      clinics: rows, operations: true, content: '<p class="card">Selecione uma clínica.</p>'
    }));
    const action = escape(adminUrl(clinic.id, undefined, 'operacao'));
    const [pending, paused] = await Promise.all([store.pending(clinic.id), store.pausedLeads(clinic.id)]);
    const jobs = pending.map(job => '<form class="entry" action="' + action + '" method="post">' +
      hidden('_csrf', csrf) + hidden('seq', job.seq) +
      '<p><strong>Evento ' + escape(job.seq) + '</strong> · <code>' + escape(job.lead.split(':').at(-1)) + '</code><br>' +
      'Referência <code>' + escape(job.reference) + '</code><br>' +
      escape(job.state === 'uncertain' ? 'Resultado incerto' : 'Bloqueado') +
      ' · ' + escape(job.step ?? 'classificação') + ' · ' + escape(job.error) + '</p>' +
      (job.state === 'uncertain' ? '<p>Confira no CRM se a mensagem ou tarefa foi criada antes de repetir.</p>' : '') +
      '<button name="acao" value="tentar">Tentar novamente</button> ' +
      '<button class="secondary" name="acao" value="descartar">Encerrar evento</button></form>').join('');
    const pauses = paused.map(({ lead }) =>
      '<form class="entry" action="' + action + '" method="post">' + hidden('_csrf', csrf) +
      hidden('lead', lead) + '<p><code>' + escape(lead.split(':').at(-1)) +
      '</code></p><button name="acao" value="reativar">Reativar IA</button></form>').join('');
    res.type('html').send(layout({ clinics: rows, current: clinic, operations: true, content:
      '<section class="card"><h2>Eventos que precisam de atenção</h2>' + (jobs || '<p>Nenhum evento pendente.</p>') + '</section>' +
      '<section class="card"><h2>Leads com a IA pausada</h2>' + (pauses || '<p>Nenhum lead pausado.</p>') + '</section>' }));
  });

  router.post('/operacao', form, protect, selected, requireClinic, async (req, res) => {
    const clinic = res.locals.clinic;
    const { acao, seq, lead } = req.body;
    const applied = acao === 'reativar' && typeof lead === 'string'
      ? await store.resume(clinic.id, lead)
      : typeof seq === 'string' && /^\d{1,18}$/.test(seq) && await store.resolve(clinic.id, seq, acao);
    if (!applied) return res.status(409).type('html').send(layout({
      clinics: await clinics.list(), current: clinic, operations: true,
      content: notice('Atualize a página. Para reativar um lead, resolva a tarefa pendente ou aguarde o processamento.', true)
    }));
    res.redirect(303, adminUrl(clinic.id, undefined, 'operacao'));
  });
  return router;
}
