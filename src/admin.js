import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { equalSecret } from './webhooks.js';
import { ClinicError, clinicKnowledge, trainingFields, uuid } from './clinics.js';
import { DocumentError, extractDocument, uploadBytes } from './documents.js';
import { minimumPasswordLength, normalizedEmail, validEmail } from './accounts.js';
import { adminAuth, loginLimit } from './admin-auth.js';
import { ClinicDataError, clinicDataFromForm, validateClinicData } from './clinic-data.js';
import { feedbackBytes } from './feedback.js';
import { simulate, validHistory } from './simulator.js';
import { accountsView, activationPage, signupPage, adminUrl, clinicDataView, connection, escape, feedbackView, hidden, layout, library, notice, simulationClinicPicker, tabs, tester, training } from './admin-view.js';

export function admin(config, clinics, store, { accounts, documents, feedback, sessions, decide }) {
  const router = express.Router();
  const auth = adminAuth(config, sessions, accounts);
  router.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer'
    });
    if (req.method !== 'GET' && req.method !== 'HEAD' && ['cross-site', 'same-site'].includes(req.get('Sec-Fetch-Site'))) {
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

  const authForm = express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 4, inflate: false });
  const signupLimit = loginLimit(24);
  let activations = 0;
  router.get('/login', auth.page);
  router.post('/login', authForm, auth.login);
  router.get('/cadastrar', (req, res) => res.type('html').send(signupPage('', req.query.enviado === '1')));
  router.post('/cadastrar', authForm, async (req, res) => {
    const retry = signupLimit.retry();
    if (retry) return res.status(429).set('Retry-After', String(retry)).type('html')
      .send(signupPage('Muitas solicitações. Tente novamente em instantes.'));
    signupLimit.fail();
    const email = normalizedEmail(req.body?.email);
    if (!validEmail(email)) return res.status(422).type('html').send(signupPage('Digite um e-mail válido.'));
    if (email !== auth.ownerEmail) await accounts.request(email);
    res.redirect(303, '/admin/cadastrar?enviado=1');
  });
  router.get('/ativar', (req, res) => res.type('html').send(activationPage()));
  router.post('/ativar', authForm, async (req, res) => {
    if (activations >= 4) return res.status(429).type('html').send(activationPage('Tente novamente em instantes.'));
    activations++;
    try {
      if (!await accounts.activate(req.body?.convite, req.body?.senha)) {
        return res.status(422).type('html').send(activationPage('Abra o link de ativação válido e use uma senha de pelo menos ' + minimumPasswordLength + ' caracteres.', req.body?.convite));
      }
      res.redirect(303, '/admin/login?ativo=1');
    } finally {
      activations--;
    }
  });

  router.use(auth.protect);
  const memberRoutes = new Set(['/treinar', '/dados', '/arquivos', '/arquivos/excluir', '/feedback', '/feedback/excluir', '/simular', '/sair']);
  router.use((req, res, next) => {
    if (res.locals.memberClinic && !memberRoutes.has(req.path)) return res.sendStatus(403);
    next();
  });
  router.post('/sair', form, protect, auth.logout);

  async function renderAccounts(res, invitation) {
    const [rows, list] = await Promise.all([clinics.list(), accounts.list()]);
    res.type('html').send(layout({
      clinics: rows, title: 'Contas e acessos', csrf: res.locals.csrf,
      content: accountsView({ clinics: rows, accounts: list, csrf: res.locals.csrf, invitation })
    }));
  }

  router.get('/contas', (req, res) => renderAccounts(res));
  router.post('/contas/convidar', form, protect, async (req, res) => {
    const { conta, clinica } = req.body ?? {};
    if (typeof conta !== 'string' || !uuid.test(conta) || !await clinics.get(clinica)) return res.sendStatus(404);
    const account = (await accounts.list()).find(row => row.id === conta);
    if (!account) return res.sendStatus(404);
    const token = await accounts.invite(conta, clinica);
    if (!token) return res.sendStatus(409);
    await renderAccounts(res, { email: account.email, path: '/admin/ativar#' + token });
  });
  router.post('/contas/revogar', form, protect, async (req, res) => {
    const id = req.body?.conta;
    if (typeof id !== 'string' || !uuid.test(id) || !await accounts.revoke(id)) return res.sendStatus(404);
    res.redirect(303, '/admin/contas');
  });

  function protect(req, res, next) {
    if (!equalSecret(req.get('X-CSRF-Token') ?? req.body?._csrf, res.locals.csrf)) return res.sendStatus(403);
    next();
  }
  async function selected(req, res, next) {
    const member = res.locals.memberClinic;
    const id = req.query.clinica ?? member;
    if (member && id !== member) return res.sendStatus(404);
    if (id == null) return next();
    const clinic = await clinics.get(id);
    if (!clinic) return res.sendStatus(404);
    res.locals.clinic = clinic;
    next();
  }
  function requireClinic(req, res, next) {
    if (!res.locals.clinic) return res.sendStatus(404);
    next();
  }

  async function renderPanel(req, res, { message = '', status = 200, attempted, version, tab = req.query.aba } = {}) {
    const clinic = res.locals.clinic;
    const member = Boolean(res.locals.memberClinic);
    if (member && tab === 'conexao') return res.sendStatus(403);
    const availableTab = typeof tab === 'string' && Object.hasOwn(tabs, tab) && (clinic || tab === 'teste');
    const active = availableTab ? tab : member ? 'treinamento' : 'conexao';
    const rows = member ? [clinic] : await clinics.list();
    const csrf = res.locals.csrf;
    let body;
    if (['arquivos', 'treinamento', 'feedback'].includes(active)) {
      const file = req.query.arquivo;
      if (file !== undefined && (typeof file !== 'string' || !uuid.test(file))) return res.sendStatus(404);
      const [docs, selectedFile, corrections] = await Promise.all([
        documents.list(clinic.id), file ? documents.read(clinic.id, file) : null,
        active === 'feedback' ? feedback.list(clinic.id) : []
      ]);
      if (file && !selectedFile) return res.sendStatus(404);
      const lead = active === 'treinamento' ? training({ clinic, attempted, csrf }) :
        active === 'feedback' ? feedbackView({ clinic, attempted, csrf, corrections }) : '';
      body = lead + library({ clinic, csrf, docs, selected: selectedFile, tab: active });
    } else if (active === 'dados') {
      body = clinicDataView({ clinic, draft: attempted, csrf, version });
    } else if (active === 'teste') {
      const simulationClinic = req.query.modo === 'rapido' ? null : clinic;
      body = tester(simulationClinic, csrf) + (member ? '' : simulationClinicPicker(rows, simulationClinic));
    } else body = connection({ clinic, attempted, csrf, webhook: clinic ? await clinics.webhookPath(clinic) : null });
    res.status(status).type('html').send(layout({
      clinics: rows, current: clinic, active, csrf, member, content: notice(message, status >= 400) + body
    }));
  }

  const messages = {
    clinic: 'Clínica salva.', dados: 'Dados e preços salvos.', training: 'Treinamento salvo.', uploaded: 'Arquivo enviado.',
    deleted: 'Arquivo excluído.', feedback: 'Feedback salvo.', feedbackDeleted: 'Feedback excluído.'
  };
  router.get('/treinar', selected, (req, res) => renderPanel(req, res, {
    message: Object.hasOwn(messages, req.query.salvo) ? messages[req.query.salvo] : ''
  }));
  const dataForm = express.urlencoded({ extended: false, limit: '192kb', parameterLimit: 220, inflate: false });
  router.post('/dados', dataForm, protect, selected, requireClinic, async (req, res) => {
    const clinic = res.locals.clinic;
    const version = req.body?.versao;
    let draft;
    try {
      draft = clinicDataFromForm(req.body ?? {});
      const data = validateClinicData(draft);
      if (!await clinics.saveData(clinic.id, version, data)) {
        return renderPanel(req, res, { tab: 'dados', status: 409, attempted: draft, version,
          message: 'A clínica foi alterada em outra tela. Copie suas alterações e recarregue antes de salvar.' });
      }
    } catch (error) {
      if (!(error instanceof ClinicDataError)) throw error;
      return renderPanel(req, res, { tab: 'dados', status: 422, attempted: draft, version, message: error.message });
    }
    res.redirect(303, adminUrl(clinic.id, 'dados') + '&salvo=dados');
  });

  router.post('/treinar', form, protect, selected, async (req, res) => {
    const clinic = res.locals.clinic;
    const trainingOnly = clinic && req.query.aba === 'treinamento';
    if (res.locals.memberClinic && !trainingOnly) return res.sendStatus(403);
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

  router.post('/feedback', form, protect, selected, requireClinic, async (req, res) => {
    const clinicId = res.locals.clinic.id;
    const content = typeof req.body.conteudo === 'string' ? req.body.conteudo.trim() : '';
    if (!content || content.includes('\0') || Buffer.byteLength(content) > feedbackBytes) {
      return renderPanel(req, res, { tab: 'feedback', status: 422, attempted: { conteudo: content },
        message: 'Digite um feedback de até 1.600 bytes. Acentos podem ocupar mais de um byte.' });
    }
    if (!await feedback.save(clinicId, content)) {
      return renderPanel(req, res, { tab: 'feedback', status: 409, attempted: { conteudo: content },
        message: 'Não foi possível salvar. Atualize a página e confira o limite de 16 feedbacks por clínica.' });
    }
    res.redirect(303, adminUrl(clinicId, 'feedback') + '&salvo=feedback');
  });

  router.post('/feedback/excluir', form, protect, selected, requireClinic, async (req, res) => {
    const clinicId = res.locals.clinic.id;
    const id = req.body.feedback;
    if (typeof id !== 'string' || !uuid.test(id) || !await feedback.remove(clinicId, id)) return res.sendStatus(404);
    res.redirect(303, adminUrl(clinicId, 'feedback') + '&salvo=feedbackDeleted');
  });

  const fileTab = req => ['treinamento', 'feedback'].includes(req.query.aba) ? req.query.aba : 'arquivos';
  router.post('/arquivos', selected, requireClinic, (req, res, next) => {
    upload(req, res, error => {
      if (!error) return next();
      if (!(error instanceof multer.MulterError)) return next(error);
      renderPanel(req, res, { tab: fileTab(req), status: 422, message: 'Envie um arquivo por vez, com até 5 MB.' }).catch(next);
    });
  }, protect, async (req, res) => {
    const clinic = res.locals.clinic;
    if (extractions >= 2) return renderPanel(req, res, { tab: fileTab(req), status: 429, message: 'Há uploads em andamento. Tente novamente em instantes.' });
    extractions++;
    try {
      await documents.save(clinic.id, await extractDocument(req.file));
      res.redirect(303, adminUrl(clinic.id, fileTab(req)) + '&salvo=uploaded');
    } catch (error) {
      if (!(error instanceof DocumentError)) throw error;
      return renderPanel(req, res, { tab: fileTab(req), status: 422, message: error.message });
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
    res.redirect(303, adminUrl(clinicId, fileTab(req)) + '&salvo=deleted');
  });

  function selectSimulationClinic(req, res, next) {
    if (req.query.modo === 'rapido' && req.query.clinica === undefined) return next();
    return selected(req, res, next);
  }

  router.post('/simular', json, protect, selectSimulationClinic, async (req, res) => {
    const { text, withAI } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim() || text.length > 1000 || typeof withAI !== 'boolean') {
      return res.status(422).json({ error: 'Digite uma mensagem com até 1.000 caracteres.' });
    }
    const clinic = res.locals.clinic;
    const history = validHistory(req.body.history);
    let knowledge;
    if (clinic) {
      const search = [text, history.at(-1)?.inbound].filter(Boolean).join(' ');
      const [references, corrections] = await Promise.all([documents.context(clinic.id, search), feedback.list(clinic.id)]);
      knowledge = { ...clinicKnowledge(clinic), references, feedback: corrections.map(row => row.conteudo) };
    } else {
      if (req.query.modo !== 'rapido') return res.sendStatus(404);
      const name = typeof req.body.nome_clinica === 'string' ? req.body.nome_clinica.trim() : '';
      if (!/^[^\u0000-\u001f\u007f]{1,120}$/u.test(name)) {
        return res.status(422).json({ error: 'Informe o nome da clínica com até 120 caracteres.' });
      }
      knowledge = { clinicName: name, files: {}, replies: new Map(), references: [] };
    }
    try {
      res.json(await simulate({ clinic, text: text.trim(), history, withAI, decide, knowledge }));
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
    const csrf = res.locals.csrf;
    if (!clinic) return res.type('html').send(layout({
      clinics: rows, csrf, operations: true, content: '<p class="card">Selecione uma clínica.</p>'
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
    res.type('html').send(layout({ clinics: rows, current: clinic, csrf, operations: true, content:
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
      clinics: await clinics.list(), current: clinic, csrf: res.locals.csrf, operations: true,
      content: notice('Atualize a página. Para reativar um lead, resolva a tarefa pendente ou aguarde o processamento.', true)
    }));
    res.redirect(303, adminUrl(clinic.id, undefined, 'operacao'));
  });
  return router;
}
