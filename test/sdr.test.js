import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { safeReply } from '../src/knowledge.js';
import { clinicKnowledge, createClinics } from '../src/clinics.js';
import { createAccounts } from '../src/accounts.js';
import { createSessions } from '../src/admin-auth.js';
import { createFeedback } from '../src/feedback.js';
import { createDocuments, extractDocument } from '../src/documents.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore, leadKey } from '../src/store.js';
import { createWorker } from '../src/worker.js';
import { bookingHandoffReply, createAgent, replies } from '../src/agent.js';
import { createApp } from '../src/server.js';
import { createCrms, OpportunityError } from '../src/crm.js';

const adminToken = 'a'.repeat(64);
const webhookToken = 'b'.repeat(64);
const templateDir = fileURLToPath(new URL('../knowledge/', import.meta.url));
const clinicForm = (type, account, fields = {}) => ({
  nome_clinica: 'Clínica ' + account, crm_tipo: type, crm_account_id: account,
  kommo_conta_id: '100', crm_token: 'token-secret-' + account, webhook_token: webhookToken,
  funil_id: '8', etapa_agendamento_id: '13', responsavel_id: '15',
  regras_negocio: '', quebra_objecoes: '', faq: '# FAQ\n', ...fields
});

const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

async function database(dataDir, migrate = true) {
  const db = new PGlite(dataDir);
  const client = Object.assign(new EventEmitter(), { query: db.query.bind(db), release() {} });
  if (migrate) {
    await db.exec(schema);
    await db.exec(readFileSync(new URL('../supabase/multi-clinica.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../supabase/painel-clinicas.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../supabase/admin-saas.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../supabase/contas-admin.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../supabase/dados-clinicas.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../supabase/cadastro-rapido.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../supabase/agendamento-erp.sql', import.meta.url), 'utf8'));
  }
  return {
    query: client.query,
    connect: async () => client,
    close: () => db.close()
  };
}

async function fixture(t) {
  const db = await database();
  t.after(() => db.close());
  const clinics = createClinics(db, { adminToken, ghl: { version: 'v3' } }, templateDir);
  return { db, clinics, store: createStore(db) };
}

function modelResult(name, args) {
  return { choices: [{ message: { tool_calls: [{
    type: 'function', function: { name, arguments: JSON.stringify(args) }
  }] } }] };
}

test('o modelo só seleciona respostas publicadas e agendamento precisa de evidência', async () => {
  const clinic = clinicForm('ghl', 'location');
  let knowledge = clinicKnowledge(clinic);
  let result;
  let requests = 0;
  let modelContext;
  const mock = { chat: { completions: { async create(request) {
    assert.equal(request.tool_choice, 'required');
    assert.equal(request.parallel_tool_calls, false);
    requests += 1;
    modelContext = JSON.parse(request.messages[1].content);
    return result;
  } } } };
  const decide = createAgent({ model: 'gpt-4o' }, mock);
  result = modelResult('responder', { resposta_id: 'https://malicioso.invalid' });
  assert.equal((await decide({ text: 'Oi' }, [], knowledge)).text, replies.convidar);

  result = modelResult('qualificar_agendamento', { trecho: 'quero agendar' });
  assert.equal((await decide({ text: 'Eu quero agendar' }, [], knowledge)).kind, 'qualificar_agendamento');
  assert.equal((await decide({ text: 'Eu não quero agendar' }, [], knowledge)).kind, 'responder');
  assert.equal((await decide({ text: 'Oi' }, [], knowledge)).kind, 'responder');
  result = modelResult('qualificar_agendamento', { trecho: 'Sim' });
  assert.equal((await decide({ text: 'Sim' }, [], knowledge)).kind, 'responder');
  assert.equal((await decide({ text: 'Sim' }, [{ offered: 1 }], knowledge)).kind, 'qualificar_agendamento');

  result = modelResult('responder', { resposta_id: 'acolher' });
  assert.equal((await decide({ text: 'Pode diagnosticar o meu caso?' }, [], knowledge)).text, replies.avaliacao);
  assert.equal((await decide({ text: 'Quero falar com um humano' }, [], knowledge)).kind, 'transbordo_humano');
  assert.equal((await decide({ text: 'Pare de me enviar mensagens' }, [], knowledge)).reason, 'descadastro');
  assert.equal(requests, 7);

  clinic.faq = '# FAQ\n<!-- respostas:sdr -->\nvalor | A consulta custa R$ 120,00.\n<!-- fim:sdr -->\n';
  knowledge = clinicKnowledge(clinic);
  result = modelResult('responder', { resposta_id: 'valor' });
  const feedback = ['Priorize o preço publicado quando houver uma pergunta direta.'];
  assert.equal((await decide({ text: 'Qual o preço?' }, [], { ...knowledge, feedback })).text, 'A consulta custa R$ 120,00.');
  assert.deepEqual(modelContext.feedbacks_da_clinica, feedback);
  knowledge.replies.set('convite_antigo', 'Quer receber o link para escolher um horário?');
  result = modelResult('responder', { resposta_id: 'convite_antigo' });
  assert.equal((await decide({ text: 'Como faço para agendar?' }, [], knowledge)).text, replies.convidar);
  assert.equal(modelContext.respostas_disponiveis.convite_antigo, undefined);
  assert.equal(safeReply('Acesse teste.com'), false);
  assert.equal(safeReply('Acesse 127.0.0.1'), false);
  assert.equal(safeReply('Acesse ｈｔｔｐ．com'), false);
  assert.equal(safeReply('Acesse teste。com'), false);
});

test('webhooks reais do Express, validação de assinatura e edição autenticada', async t => {
  const { db, clinics, store } = await fixture(t);
  const ghlId = await clinics.save(clinicForm('ghl', 'branch'));
  const kommoId = await clinics.save(clinicForm('kommo', 'demo'));
  const otherId = await clinics.save(clinicForm('ghl', 'other'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const config = { adminToken, ghl: { publicKey } };
  const server = createApp(config, store, clinics, { documents: createDocuments(db), feedback: createFeedback(db), sessions: createSessions(db) }).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;

  const ghlBody = JSON.stringify({
    type: 'InboundMessage', direction: 'inbound', locationId: 'branch', contactId: 'contact',
    messageId: 'ghi', conversationId: 'conv', messageTypeString: 'TYPE_WHATSAPP', body: 'Oi'
  });
  const signature = sign(null, Buffer.from(ghlBody), privateKey).toString('base64');
  const requestGhl = (body, clinicId = ghlId) => fetch(base + '/webhook/ghl/' + clinicId, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GHL-Signature': signature }, body
  });
  assert.equal((await requestGhl(ghlBody + ' ')).status, 401);
  assert.equal((await requestGhl(ghlBody, otherId)).status, 200);
  assert.equal(await store.claim(), null);
  assert.equal((await requestGhl(ghlBody)).status, 200);
  assert.equal((await requestGhl(ghlBody)).status, 200);

  const kommoForm = new URLSearchParams({
    'account[id]': '100', 'account[subdomain]': 'demo', 'message[add][0][id]': 'abc',
    'message[add][0][type]': 'incoming', 'message[add][0][author][type]': 'external',
    'message[add][0][entity_type]': 'lead', 'message[add][0][entity_id]': '110',
    'message[add][0][talk_id]': '111', 'message[add][0][text]': 'Oi'
  });
  const requestKommo = token => fetch(base + '/webhook/kommo/' + kommoId + '?token=' + token, { method: 'POST', body: kommoForm });
  assert.equal((await requestKommo('invalido')).status, 401);
  assert.equal((await requestKommo(webhookToken)).status, 200);
  kommoForm.set('account[id]', '200');
  kommoForm.set('message[add][0][id]', 'other');
  assert.equal((await requestKommo(webhookToken)).status, 200);
  kommoForm.set('account[id]', '100');
  kommoForm.set('message[add][0][id]', 'echo');
  kommoForm.set('message[add][0][type]', 'outgoing');
  assert.equal((await requestKommo(webhookToken)).status, 200);

  const ghlJob = await store.claim();
  assert.equal(ghlJob.event.channel, 'WhatsApp');
  assert.equal(ghlJob.clinica_id, ghlId);
  await store.finish(ghlJob);
  const kommoJob = await store.claim();
  assert.equal(kommoJob.event.conversationId, '111');
  assert.equal(kommoJob.clinica_id, kommoId);
  await store.finish(kommoJob);
  assert.equal(await store.claim(), null);

  const adminUrl = base + '/admin/treinar';
  const anonymous = await fetch(adminUrl, { redirect: 'manual' });
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get('location'), '/admin/login');
  assert.equal(anonymous.headers.get('www-authenticate'), null);
  const login = await fetch(base + '/admin/login', {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ email: 'admin@robocrc.local', senha: adminToken })
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /Max-Age=28800; Path=\/; Expires=.*; HttpOnly; Secure; SameSite=Lax/);
  const headers = { Cookie: cookie.split(';')[0] };
  const html = await (await fetch(adminUrl, { headers })).text();
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
  const submit = (url, fields) => fetch(url, {
    method: 'POST', headers, redirect: 'manual', body: new URLSearchParams(fields)
  });
  assert.equal((await submit(adminUrl, { ...clinicForm('ghl', 'third'), _csrf: 'invalido' })).status, 403);
  const newClinic = await submit(adminUrl, { ...clinicForm('ghl', 'third'), _csrf: csrf });
  assert.equal(newClinic.status, 303);
  assert.match(newClinic.headers.get('location'), /clinica=/);

  const current = await clinics.get(ghlId);
  const editUrl = adminUrl + '?clinica=' + ghlId + '&aba=treinamento';
  const content = '# FAQ\n</textarea><script>alert(1)</script>\n';
  const fields = {
    ...clinicForm('ghl', 'malicious-account'), crm_token: '', faq: content,
    _csrf: csrf, versao: String(current.versao)
  };
  assert.equal((await submit(editUrl, fields)).status, 303);
  assert.equal((await submit(editUrl, fields)).status, 422);
  assert.equal((await clinics.get(ghlId)).crm_account_id, 'branch');
  assert.equal((await clinics.get(ghlId)).faq, content);
  assert.equal((await clinics.get(otherId)).faq, '# FAQ\n');
  assert.equal((await clinics.integration(ghlId)).ghl.token, 'token-secret-branch');
  const encrypted = (await db.query('SELECT crm_token FROM sdr.clinicas WHERE id = $1', [ghlId])).rows[0].crm_token;
  assert.match(encrypted, /^v1\./);
  assert.doesNotMatch(encrypted, /token-secret/);
  assert.equal(await clinics.webhookPath(await clinics.get(kommoId)), '/webhook/kommo/' + kommoId + '?token=' + webhookToken);
  const route = await clinics.routing(kommoId);
  assert.match(route.webhook_token_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(route.webhook_token_hash, webhookToken);
  await assert.rejects(clinics.save(clinicForm('ghl', 'branch')), /já está vinculada/);
  const updated = await (await fetch(editUrl, { headers })).text();
  assert.ok(updated.includes('&lt;/textarea&gt;&lt;script&gt;'));
  assert.doesNotMatch(updated, /<script>|token-secret-branch/);

  await store.enqueue([event('stored-before-disable', ghlId)]);
  const configUrl = adminUrl + '?clinica=' + ghlId + '&aba=conexao';
  const updateStatus = async ativo => submit(configUrl, {
    ...clinicForm('ghl', 'branch'), crm_token: '', _csrf: csrf, ativo,
    versao: String((await clinics.get(ghlId)).versao)
  });
  assert.equal((await updateStatus('nao')).status, 303);
  assert.equal((await clinics.get(ghlId)).ativo, false);
  const newBody = ghlBody.replace('"ghi"', '"new-inactive"');
  const inactive = await fetch(base + '/webhook/ghl/' + ghlId, {
    method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-GHL-Signature': sign(null, Buffer.from(newBody), privateKey).toString('base64')
    }, body: newBody
  });
  assert.equal(inactive.status, 200);
  assert.equal(await store.claim(), null);
  assert.equal((await updateStatus('sim')).status, 303);
  const restored = await store.claim();
  assert.equal(restored.event.eventId, 'stored-before-disable');
  await store.finish(restored);
  assert.equal(await store.claim(), null);
  assert.equal((await submit(base + '/admin/sair', { _csrf: 'errado' })).status, 403);
  const logout = await submit(base + '/admin/sair', { _csrf: csrf });
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get('location'), '/admin/login');
  assert.match(logout.headers.get('set-cookie'), /^__Host-crc_session=;/);
  assert.equal((await fetch(adminUrl, { headers, redirect: 'manual' })).status, 303);
});

function event(eventId, clinicId, account = 'branch', text = 'Quero agendar') {
  return { clinicId, provider: 'ghl', account, leadId: '99', eventId, conversationId: '11', text };
}

test('fila usa treinamento, credenciais, tarefas, histórico e pausas de cada clínica', async t => {
  const { clinics, store, db } = await fixture(t);
  const documents = createDocuments(db);
  const faq = name => '<!-- respostas:sdr -->\nresposta | Conhecimento ' + name + '.\n<!-- fim:sdr -->';
  const first = await clinics.save(clinicForm('ghl', 'a', { faq: faq('Alfa') }));
  const second = await clinics.save(clinicForm('ghl', 'b', { faq: faq('Beta') }));
  const feedback = createFeedback(db);
  await feedback.save(first, 'Feedback Alfa');
  await feedback.save(second, 'Feedback Beta');
  const actions = [];
  const crmFor = integration => ({
    ghl: {
      async qualify(e) { actions.push(['qualify', e.clinicId, integration.ghl.token]); },
      async send(e, text) { actions.push(['send', e.clinicId, text]); },
      async handoff(e, note) {
        assert.equal(await store.paused(e.clinicId, leadKey(e)), true);
        assert.match(note, e.text === 'Humano' ? /atendimento humano/ : /agendamento no ERP/);
        actions.push(['handoff', e.clinicId]);
      }
    }
  });
  const decide = async (e, history, training) => {
    assert.equal(training.replies.get('resposta'), e.clinicId === first ? 'Conhecimento Alfa.' : 'Conhecimento Beta.');
    assert.deepEqual(training.feedback, [e.clinicId === first ? 'Feedback Alfa' : 'Feedback Beta']);
    if (e.eventId === '1') assert.deepEqual(history, []);
    assert.deepEqual(training.references.map(file => file.nome), [e.clinicId === first ? 'alfa.txt' : 'beta.txt']);
    return e.text === 'Humano'
      ? { kind: 'transbordo_humano', reason: 'humano' } : { kind: 'qualificar_agendamento' };
  };
  await documents.save(first, await extractDocument({ originalname: 'alfa.txt', buffer: Buffer.from('Documento Alfa') }));
  await documents.save(second, await extractDocument({ originalname: 'beta.txt', buffer: Buffer.from('Documento Beta') }));
  const worker = createWorker({ store, decide, integrationFor: clinics.integration, crmFor, documents, feedback });
  const a = event('1', first, 'a');
  const b = event('1', second, 'b');
  await store.enqueue([a, event('3', first, 'a'), { ...event('2', first, 'a', 'Humano'), leadId: '100' }, b]);
  for (let i = 0; i < 4; i++) await worker.tick();
  assert.deepEqual(actions, [
    ['qualify', first, 'token-secret-a'],
    ['handoff', first],
    ['send', first, bookingHandoffReply],
    ['handoff', first],
    ['qualify', second, 'token-secret-b'],
    ['handoff', second],
    ['send', second, bookingHandoffReply]
  ]);
  assert.equal(await store.resume(second, leadKey(a)), false);
  assert.equal(await store.resume(first, leadKey(a)), true);
  assert.equal(await store.paused(second, leadKey(b)), true);
});

test('reinício preserva clínica, pausa e recuperação de fila com efeito incerto', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sdr-tests-'));
  const original = await database(dir);
  const config = { adminToken, ghl: { version: 'v3' } };
  const clinics = createClinics(original, config, templateDir);
  const id = await clinics.save(clinicForm('ghl', 'branch', { faq: 'Texto publicado' }));
  const other = await clinics.save(clinicForm('ghl', 'other'));
  const before = createStore(original);
  await original.query("INSERT INTO sdr.jobs(id,lead,event) VALUES ('old-id','old-lead','{}')");
  const entry = event('1', id);
  await before.enqueue([entry]);
  const handoff = await before.claim();
  await before.plan(handoff, { kind: 'transbordo_humano', reason: 'humano' }, 'handoff');
  await before.startEffect(handoff);
  await original.close();

  const restarted = await database(dir, false);
  t.after(async () => {
    await restarted.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const after = createStore(restarted);
  await after.withWorker(async worker => {
    assert.equal((await worker.pending(id))[0].state, 'uncertain');
  });
  assert.equal(await after.paused(id, leadKey(entry)), true);
  assert.equal((await createClinics(restarted, config, templateDir).get(id)).faq, 'Texto publicado');
  await after.enqueue([entry]);
  assert.equal(await after.claim(), null);
  const [job] = await after.pending(id);
  assert.equal(await after.resolve(other, job.seq, 'tentar'), false);
  assert.equal(await after.resolve(id, job.seq, 'tentar'), true);
  assert.equal((await after.claim()).step, 'handoff');
});


test('GHL recusa oportunidades ambíguas e CRM recebe as rotas oficiais', async () => {
  const calls = [];
  const contact = { ...event('id'), channel: 'SMS' };
  const found = { id: 'opp1', contactId: contact.leadId, locationId: 'location',
    pipelineId: 'pipe', pipelineStageId: 'old', status: 'open' };
  let duplicates = true;
  const makeClient = options => ({
    async get(endpoint, query) {
      calls.push(['get', endpoint, query]);
      if (options.baseURL.includes('kommo')) return { data: { id: 99, pipeline_id: 8, status_id: 12 } };
      return { data: { opportunities: [found], meta: { total: duplicates ? 2 : 1 } } };
    },
    async put(endpoint, body) { calls.push(['put', endpoint, body]); },
    async patch(endpoint, body) { calls.push(['patch', endpoint, body]); },
    async post(endpoint, body) { calls.push(['post', endpoint, body]); }
  });
  const crm = createCrms({
    kommo: { subdomain: 'demo', pipelineId: 8, stageId: 13 },
    ghl: { locationId: 'location', pipelineId: 'pipe', stageId: 'qualified', version: 'v3' }
  }, makeClient);
  await assert.rejects(crm.ghl.qualify(contact), OpportunityError);
  assert.equal(calls.length, 1);
  duplicates = false;
  await crm.ghl.qualify(contact);
  await crm.ghl.send(contact, 'Oi!');
  await crm.kommo.qualify(event('id', 'kommo'));
  await crm.kommo.send(event('id', 'kommo'), 'Oi!');
  assert.deepEqual(calls[1], ['get', '/opportunities/search', { params: {
    locationId: 'location', pipelineId: 'pipe', contactId: '99', status: 'open', page: 1, limit: 20
  } }]);
  assert.deepEqual(calls[2], ['put', '/opportunities/opp1', { pipelineStageId: 'qualified' }]);
  assert.deepEqual(calls[3], ['post', '/conversations/messages',
    { type: 'SMS', contactId: '99', message: 'Oi!', status: 'pending' }]);
  assert.deepEqual(calls[5], ['patch', '/leads/99', { pipeline_id: 8, status_id: 13 }]);
  assert.deepEqual(calls[6], ['post', '/talks/11/send_message', { text: 'Oi!' }]);
});

test('a configuração inicia sem variáveis de CRM ou de agendamento', () => {
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    'import { loadConfig } from ' + JSON.stringify(configUrl) + '; console.log(loadConfig().port);'
  ], { env: {
    DATABASE_URL: 'postgresql://sdr@example.com/postgres',
    OPENAI_API_KEY: 'fake-for-test',
    ADMIN_TOKEN: adminToken
  } }).toString().trim();
  assert.equal(output, '3000');
});

test('biblioteca e simulador ficam isolados por clínica e não gravam eventos reais', async t => {
  const { clinics, db, store } = await fixture(t);
  const faq = '<!-- respostas:sdr -->\nhorario | Atendemos aos sábados.\n<!-- fim:sdr -->';
  const first = await clinics.save(clinicForm('ghl', 'first', { faq }));
  const second = await clinics.save(clinicForm('ghl', 'second'));
  const docs = createDocuments(db);
  const feedback = createFeedback(db);
  let modelRefs;
  let modelFeedback;
  let modelClinicName;
  const server = createApp({ adminToken, ghl: {} }, store, clinics, {
    documents: docs, feedback, decide: async (event, history, knowledge) => {
      modelRefs = knowledge.references;
      modelFeedback = knowledge.feedback;
      modelClinicName = knowledge.clinicName;
      return { kind: 'responder', text: replies.convidar, offer: true };
    }
  }).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: 'Bearer ' + adminToken };
  const site = id => base + '/admin/treinar?clinica=' + id + '&aba=arquivos';
  const simulatorPage = base + '/admin/treinar?aba=teste';
  const entry = await fetch(simulatorPage, { headers });
  assert.equal(entry.status, 200);
  const picker = await entry.text();
  assert.match(picker, /Usar uma clínica cadastrada/);
  assert.match(picker, new RegExp(first));
  assert.match(picker, new RegExp(second));
  assert.match(picker, /data-simulator.*modo=rapido/);
  const selectedSimulator = await (await fetch(simulatorPage + '&clinica=' + first, { headers })).text();
  assert.match(selectedSimulator, /data-simulator/);
  assert.match(selectedSimulator, /Simulação sem IA/);
  const html = await (await fetch(site(first), { headers })).text();
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
  const trainingUrl = site(first).replace('aba=arquivos', 'aba=treinamento');
  const feedbackUrl = site(first).replace('aba=arquivos', 'aba=feedback');
  for (const url of [trainingUrl, feedbackUrl]) {
    const html = await (await fetch(url, { headers })).text();
    assert.match(html, /data-drop/);
  }
  const comment = 'Treino exclusivo da clínica. <script>teste</script>';
  const saveFeedback = await fetch(base + '/admin/feedback?clinica=' + first, {
    method: 'POST', headers, redirect: 'manual', body: new URLSearchParams({ _csrf: csrf, conteudo: comment })
  });
  assert.equal(saveFeedback.status, 303);
  assert.match(saveFeedback.headers.get('location'), /aba=feedback/);
  const added = await (await fetch(feedbackUrl, { headers })).text();
  assert.match(added, /Treino exclusivo da clínica. &lt;script&gt;/);
  assert.doesNotMatch(await (await fetch(feedbackUrl.replace(first, second), { headers })).text(), /Treino exclusivo/);
  const makeUpload = () => {
    const form = new FormData();
    form.set('_csrf', csrf);
    form.set('arquivo', new Blob(['Atendimento aos sábados às 10 horas. <script>']), 'atendimento.txt');
    return form;
  };
  const upload = () => fetch(base + '/admin/arquivos?clinica=' + first + '&aba=treinamento',
    { method: 'POST', headers, body: makeUpload(), redirect: 'manual' });
  const uploaded = await upload();
  assert.equal(uploaded.status, 303);
  assert.match(uploaded.headers.get('location'), /aba=treinamento/);
  assert.equal((await upload()).status, 422);
  const [file] = await docs.list(first);
  assert.equal((await docs.list(second)).length, 0);
  const opened = await (await fetch(site(first) + '&arquivo=' + file.id, { headers })).text();
  assert.match(opened, /Atendimento aos sábados/);
  assert.doesNotMatch(opened, /<script>/);
  assert.equal((await fetch(site(second) + '&arquivo=' + file.id, { headers })).status, 404);

  const simulation = (id, withAI, text = 'Qual o horário aos sábados?') => fetch(base + '/admin/simular?clinica=' + id, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ withAI, text })
  });
  const noAI = await (await simulation(first, false)).json();
  assert.equal(noAI.reply, 'Atendemos aos sábados.');
  assert.deepEqual(noAI.sources, ['atendimento.txt']);
  assert.equal(noAI.feedbackCount, 1);
  const appointment = await (await simulation(first, false, 'Eu quero agendar')).json();
  assert.equal(appointment.reply, bookingHandoffReply);
  assert.equal(appointment.action, 'Encaminhar para agendamento no ERP');
  assert.equal((await simulation(first, true)).status, 200);
  assert.deepEqual(modelFeedback, [comment]);
  assert.match(modelRefs[0].trecho, /sábados/);
  const quickAI = await fetch(base + '/admin/simular?modo=rapido', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ withAI: true, text: 'Oi', nome_clinica: 'Clínica first' })
  });
  assert.equal(quickAI.status, 200);
  assert.equal((await quickAI.json()).reply, 'Oi! Como posso ajudar?');
  assert.equal(modelClinicName, 'Clínica first');
  assert.deepEqual(modelRefs, []);
  assert.equal(modelFeedback, undefined);
  assert.deepEqual((await (await simulation(second, false)).json()).sources, []);
  assert.equal((await simulation(second, true)).status, 200);
  assert.deepEqual(modelFeedback, []);
  const [correction] = await feedback.list(first);
  const removeFeedback = id => fetch(base + '/admin/feedback/excluir?clinica=' + id, {
    method: 'POST', headers, redirect: 'manual', body: new URLSearchParams({ _csrf: csrf, feedback: correction.id })
  });
  assert.equal((await removeFeedback(second)).status, 404);
  assert.equal((await removeFeedback(first)).status, 303);
  assert.equal((await simulation(first, true)).status, 200);
  assert.deepEqual(modelFeedback, []);
  assert.equal(await store.claim(), null);
  const remove = id => fetch(base + '/admin/arquivos/excluir?clinica=' + id, {
    method: 'POST', headers, redirect: 'manual', body: new URLSearchParams({ _csrf: csrf, arquivo: file.id })
  });
  assert.equal((await remove(second)).status, 404);
  assert.equal((await remove(first)).status, 303);
  assert.deepEqual(await docs.list(first), []);
});

test('credenciais personalizadas substituem o fallback e sessões vencidas são recusadas', async t => {
  const { clinics, db, store } = await fixture(t);
  const config = { adminToken, adminEmail: 'admin@example.com', adminPassword: 'Adm#82L!', ghl: {} };
  const server = createApp(config, store, clinics, { sessions: createSessions(db) }).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const login = (email, senha, headers) => fetch(base + '/admin/login', {
    method: 'POST', headers, redirect: 'manual', body: new URLSearchParams({ email, senha })
  });
  assert.equal((await login('admin@robocrc.local', adminToken)).status, 401);
  assert.equal((await login(config.adminEmail, config.adminPassword, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await fetch(base + '/admin/treinar', {
    headers: { Authorization: 'Bearer ' + adminToken }, redirect: 'manual'
  })).status, 303);
  const result = await login('ADMIN@example.com', config.adminPassword);
  assert.equal(result.status, 303);
  const headers = { Cookie: result.headers.get('set-cookie').split(';')[0] };
  assert.equal((await fetch(base + '/admin/treinar', { headers })).status, 200);
  const emptySimulator = await (await fetch(base + '/admin/treinar?aba=teste', { headers })).text();
  assert.match(emptySimulator, /Nome da clínica/);
  assert.match(emptySimulator, /data-simulator.*modo=rapido/);
  assert.doesNotMatch(emptySimulator, /Carregar simulador/);
  const csrf = emptySimulator.match(/name="_csrf" value="([^"]+)"/)[1];
  const quick = (name, text, history) => fetch(base + '/admin/simular?modo=rapido', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ nome_clinica: name, text, withAI: false, history })
  });
  assert.equal((await quick('   ', 'Oi')).status, 422);
  const start = await (await quick('Clínica de teste', 'Oi')).json();
  assert.equal(start.reply, 'Oi! Como posso ajudar?');
  assert.equal(start.offered, false);
  const pricing = await (await quick('Clínica de teste', 'Quanto custa a consulta?')).json();
  assert.match(pricing.reply, /informação ainda não está disponível/);
  assert.equal(pricing.offered, true);
  const appointment = await (await quick('Clínica de teste', 'Sim', [{
    inbound: 'Quanto custa a consulta?', outbound: pricing.reply, offered: pricing.offered
  }])).json();
  assert.equal(appointment.reply, bookingHandoffReply);
  assert.equal(appointment.action, 'Encaminhar para agendamento no ERP');
  assert.deepEqual(appointment.sources, []);
  await db.query("UPDATE sdr.admin_sessions SET expires_at=now() - interval '1 second'");
  assert.equal((await fetch(base + '/admin/treinar', { headers, redirect: 'manual' })).status, 303);
});

test('cadastro por e-mail requer convite, isola a clínica e revoga a sessão', async t => {
  const { clinics, db, store } = await fixture(t);
  const assigned = await clinics.save(clinicForm('ghl', 'assigned', { nome_clinica: 'Clínica atribuída' }));
  const other = await clinics.save(clinicForm('ghl', 'other', { nome_clinica: 'Clínica secreta' }));
  const accounts = createAccounts(db);
  const server = createApp({ adminToken, ghl: {} }, store, clinics, {
    accounts, documents: createDocuments(db), feedback: createFeedback(db), sessions: createSessions(db)
  }).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port + '/admin';
  const call = (path, headers, fields) => fetch(base + path, {
    method: fields ? 'POST' : 'GET', headers, redirect: 'manual',
    body: fields ? new URLSearchParams(fields) : undefined
  });
  const email = 'recepcao@example.com';
  const senha = 'Eqp#82S!';
  assert.equal((await call('/cadastrar', {}, { email: '  RECEPCAO@example.com  ' })).status, 303);
  assert.equal((await call('/cadastrar', {}, { email })).status, 303);
  assert.equal((await call('/login', {}, { email, senha })).status, 401);

  const ownerLogin = await call('/login', {}, { email: 'admin@robocrc.local', senha: adminToken });
  assert.equal(ownerLogin.status, 303);
  const owner = { Cookie: ownerLogin.headers.get('set-cookie').split(';')[0] };
  const requests = await (await call('/contas', owner)).text();
  assert.match(requests, /Aguardando aprovação/);
  const ownerCsrf = requests.match(/name="_csrf" value="([^"]+)"/)[1];
  const id = requests.match(/name="conta" value="([^"]+)"/)[1];
  const invite = await call('/contas/convidar', owner, { _csrf: ownerCsrf, conta: id, clinica: assigned });
  assert.equal(invite.status, 200);
  const token = (await invite.text()).match(/\/admin\/ativar#([a-f0-9]{64})/)[1];
  const stored = (await db.query('SELECT invitation_hash FROM sdr.admin_accounts WHERE id=$1', [id])).rows[0];
  assert.notEqual(stored.invitation_hash, token);
  assert.equal((await call('/ativar', {}, { convite: token, senha: senha.slice(0, -1) })).status, 422);
  assert.equal((await call('/ativar', {}, { convite: token, senha })).status, 303);
  assert.equal((await call('/ativar', {}, { convite: token, senha })).status, 422);
  const session = await call('/login', {}, { email, senha });
  assert.equal(session.status, 303);
  const member = { Cookie: session.headers.get('set-cookie').split(';')[0] };
  const panel = await (await call('/treinar', member)).text();
  assert.match(panel, /Clínica atribuída/);
  const memberSimulator = await call('/treinar?aba=teste', member);
  assert.equal(memberSimulator.status, 200);
  const memberSimulatorHtml = await memberSimulator.text();
  assert.match(memberSimulatorHtml, /data-simulator/);
  assert.doesNotMatch(memberSimulatorHtml, /Clínica secreta|simulador-clinica/);
  const quickMember = await (await call('/treinar?aba=teste&modo=rapido', member)).text();
  assert.match(quickMember, /data-simulator.*modo=rapido/);
  assert.doesNotMatch(quickMember, /Clínica secreta/);
  assert.equal((await call('/treinar?aba=teste&clinica=' + other, member)).status, 404);
  assert.doesNotMatch(panel, /Clínica secreta|Nova Clínica|Contas e acessos|Copiar Link/);
  const csrf = panel.match(/name="_csrf" value="([^"]+)"/)[1];
  assert.equal((await call('/treinar?clinica=' + other, member)).status, 404);
  assert.equal((await call('/treinar?aba=conexao', member)).status, 403);
  assert.doesNotMatch(await (await call('/treinar?aba=conexao&aba=conexao', member)).text(), /Copiar Link/);
  assert.equal((await call('/treinar?clinica=' + assigned, member, { _csrf: csrf })).status, 403);
  assert.equal((await call('/contas', member)).status, 403);
  assert.equal((await call('/operacao', member)).status, 403);
  assert.equal((await call('/feedback?clinica=' + other, member, { _csrf: csrf, conteudo: 'Outro' })).status, 404);
  assert.equal((await call('/feedback?clinica=' + assigned, member, { _csrf: csrf, conteudo: 'Da própria clínica' })).status, 303);
  assert.equal((await call('/contas/revogar', owner, { _csrf: ownerCsrf, conta: id })).status, 303);
  assert.equal((await call('/treinar', member)).status, 303);
});

test('dados e preços salvam por clínica e alimentam o simulador e a decisão real', async t => {
  const { clinics, db, store } = await fixture(t);
  const faq = '<!-- respostas:sdr -->\nvalor | A consulta custa R$ 90,00.\n<!-- fim:sdr -->';
  const first = await clinics.save(clinicForm('ghl', 'first-data', { faq }));
  const second = await clinics.save(clinicForm('ghl', 'second-data'));
  let modelContext;
  let selected = 'valor';
  const decide = createAgent({ model: 'gpt-4o' }, { chat: { completions: { async create(request) {
    modelContext = JSON.parse(request.messages[1].content);
    return modelResult('responder', { resposta_id: selected });
  } } } });
  const docs = createDocuments(db);
  const notes = createFeedback(db);
  await notes.save(first, 'Orientação da primeira clínica');
  const server = createApp({ adminToken, ghl: {} }, store, clinics, {
    documents: docs, feedback: notes, sessions: createSessions(db), decide
  }).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port + '/admin';
  const headers = { Authorization: 'Bearer ' + adminToken };
  const view = id => base + '/treinar?aba=dados&clinica=' + id;
  const html = await (await fetch(view(first), { headers })).text();
  assert.match(html, /Informações da Clínica/);
  assert.match(html, /Adicionar serviço/);
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
  const version = String((await clinics.get(first)).versao);
  const values = {
    _csrf: csrf, versao: version, endereco: 'Rua das Flores, 120',
    referencia: 'Ao lado da praça', maps_url: 'https://maps.app.goo.gl/abc123',
    horario: 'Segunda a sexta, das 8h às 18h', recepcao: '(85) 98888-1234',
    prof_nome: 'Dra. Ana Silva', prof_especialidade: 'Urologia', prof_registro: 'CRM-CE 12345',
    serv_nome: 'Consulta inicial', serv_descricao: 'Consulta presencial',
    serv_valor: 'R$ 150 a R$ 200', serv_duracao: '40 minutos',
    serv_pagamento: 'Pix ou cartão', serv_convenios: 'Plano Saúde'
  };
  const save = overrides => fetch(base + '/dados?clinica=' + first, {
    method: 'POST', headers, redirect: 'manual', body: new URLSearchParams({ ...values, ...overrides })
  });
  assert.equal((await save({ maps_url: 'https://maps.app.goo.gl.example.org/fake' })).status, 422);
  assert.equal((await save({ serv_descricao: 'Veja exemplo.com.br' })).status, 422);
  assert.equal((await save()).status, 303);
  assert.equal((await save()).status, 409);
  assert.match(await (await fetch(view(first), { headers })).text(), /R\$ 150 a R\$ 200/);
  assert.doesNotMatch(await (await fetch(view(second), { headers })).text(), /Rua das Flores|R\$ 150/);
  const sim = async (id, text, withAI = false) => (await fetch(base + '/simular?clinica=' + id, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ text, withAI })
  })).json();
  assert.equal((await sim(first, 'Quanto custa a consulta inicial?')).reply, 'Valor de Consulta inicial: R$ 150 a R$ 200');
  assert.equal((await sim(first, 'Quanto custa a consulta?')).reply, 'Valor de Consulta inicial: R$ 150 a R$ 200');
  assert.equal((await sim(first, 'Quanto custa a consulta inicial?', true)).reply, 'Valor de Consulta inicial: R$ 150 a R$ 200');
  assert.equal(modelContext.dados_da_clinica.contato.maps_url, values.maps_url);
  assert.deepEqual(modelContext.feedbacks_da_clinica, ['Orientação da primeira clínica']);
  assert.equal((await sim(first, 'Qual o WhatsApp da recepção?')).reply, 'Telefone ou WhatsApp da recepção: (85) 98888-1234');
  assert.equal((await sim(first, 'Qual o CRM da Dra. Ana Silva?')).reply, 'Profissional: Dra. Ana Silva · Urologia · CRM-CE 12345');
  assert.equal((await sim(first, 'Pode mandar o Google Maps?')).reply, 'Endereço: Rua das Flores, 120');
  assert.doesNotMatch((await sim(second, 'Quanto custa a consulta inicial?', true)).reply, /150|200/);
  assert.deepEqual(modelContext.dados_da_clinica, {});
  selected = 'cadastro_servico_0_valor';
  assert.equal((await sim(first, 'Quanto custa o implante?', true)).reply, replies.sem_informacao);
  const integration = await clinics.integration(first);
  assert.equal(integration.knowledge.clinicData.contato.endereco, values.endereco);
  const sent = [];
  selected = 'valor';
  const worker = createWorker({ store, documents: docs, feedback: notes, decide, integrationFor: clinics.integration,
    crmFor: () => ({ ghl: { send: async (event, text) => sent.push(text) } })
  });
  await store.enqueue([event('structured-data', first, 'first-data', 'Quanto custa a consulta inicial?')]);
  await worker.tick();
  assert.deepEqual(sent, ['Valor de Consulta inicial: R$ 150 a R$ 200']);

  await store.enqueue([event('structured-retry', first, 'first-data', 'Quanto custa a consulta inicial?')]);
  const retry = await store.claim();
  await store.plan(retry, { kind: 'responder', text: 'Valor de Consulta inicial: R$ 150 a R$ 200' }, 'send');
  await store.fail(retry, 'queued', 'retry');
  assert.equal((await save({ versao: String((await clinics.get(first)).versao), serv_valor: 'R$ 220' })).status, 303);
  await worker.tick();
  assert.deepEqual(sent, ['Valor de Consulta inicial: R$ 150 a R$ 200', 'Valor de Consulta inicial: R$ 220']);
});

test('clínica criada só com nome pode ser treinada e simulada antes de conectar o CRM', async t => {
  const { clinics, db, store } = await fixture(t);
  let modelContext;
  const decide = createAgent({ model: 'gpt-4o' }, { chat: { completions: { async create(request) {
    modelContext = JSON.parse(request.messages[1].content);
    return modelResult('responder', { resposta_id: 'cadastro_observacao_0' });
  } } } });
  const docs = createDocuments(db);
  const feedback = createFeedback(db);
  const server = createApp({ adminToken, ghl: {} }, store, clinics, {
    documents: docs, feedback, sessions: createSessions(db), decide
  }).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: 'Bearer ' + adminToken };
  const html = await (await fetch(base + '/admin/treinar', { headers })).text();
  assert.match(html, /Criar clínica/);
  assert.doesNotMatch(html, /name="crm_token"|name="agendamento_url"/);
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
  const post = (path, values) => fetch(base + path, {
    method: 'POST', redirect: 'manual', headers, body: new URLSearchParams({ ...values, _csrf: csrf })
  });
  assert.equal((await post('/admin/treinar', { nome_clinica: ' ' })).status, 422);
  const created = await post('/admin/treinar', { nome_clinica: 'Clínica Rápida' });
  assert.equal(created.status, 303);
  assert.match(created.headers.get('location'), /aba=dados/);
  const draft = (await clinics.list())[0];
  assert.equal(draft.crm_tipo, null);
  assert.equal(draft.ativo, false);
  assert.equal(await clinics.webhookPath(draft), null);
  const view = '/admin/treinar?clinica=' + draft.id;
  const version = async () => String((await clinics.get(draft.id)).versao);
  assert.equal((await post(view + '&aba=treinamento', {
    versao: await version(), regras_negocio: 'Acolha com cuidado.', quebra_objecoes: '', faq: ''
  })).status, 303);
  const notes = 'Estacionamento gratuito na lateral.\nPara ultrassom, chegue com 20 minutos de antecedência.';
  const dataUrl = '/admin/dados?clinica=' + draft.id;
  assert.equal((await post(dataUrl, { versao: await version(), observacoes: 'Visite https://example.com' })).status, 422);
  assert.equal((await post(dataUrl, { versao: await version(), observacoes: notes })).status, 303);
  const info = await (await fetch(base + view + '&aba=dados', { headers })).text();
  assert.match(info, /Estacionamento gratuito/);
  assert.match(info, /Observações gerais da clínica/);
  const sim = async (text, withAI = false) => (await fetch(base + '/admin/simular?clinica=' + draft.id, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ text, withAI })
  })).json();
  assert.equal((await sim('Tem estacionamento?')).reply, 'Orientação da clínica: Estacionamento gratuito na lateral.');
  assert.match((await sim('Qual o preparo para ultrassom?')).reply, /20 minutos/);
  assert.match((await sim('Tem estacionamento?', true)).reply, /Estacionamento gratuito/);
  assert.equal(modelContext.dados_da_clinica.observacoes, notes);
  assert.equal(modelContext.base_de_conhecimento['regras_negocio.md'], 'Acolha com cuidado.');
  assert.equal((await sim('Quero agendar')).reply, bookingHandoffReply);
  const connectionUrl = view + '&aba=conexao';
  const connection = await (await fetch(base + connectionUrl, { headers })).text();
  assert.doesNotMatch(connection, /name="agendamento_url"|nome e agenda|link de agendamento/i);
  assert.equal((await post(connectionUrl, { versao: await version(), nome_clinica: 'Clínica Renomeada',
    configuracao: 'rascunho' })).status, 303);
  assert.equal((await clinics.get(draft.id)).nome_clinica, 'Clínica Renomeada');
  assert.equal((await clinics.get(draft.id)).crm_tipo, null);
  const fields = clinicForm('kommo', 'draft-account', { nome_clinica: draft.nome_clinica });
  assert.equal((await post(connectionUrl, { ...fields, versao: await version(), crm_token: '' })).status, 422);
  assert.equal((await post(connectionUrl, { ...fields, versao: await version() })).status, 303);
  const connected = await clinics.get(draft.id);
  assert.equal(connected.crm_tipo, 'kommo');
  assert.equal(connected.ativo, true);
  assert.equal(connected.dados_publicos.observacoes, notes);
  assert.equal(connected.regras_negocio, 'Acolha com cuidado.');
  assert.match(await clinics.webhookPath(connected), /webhook\/kommo/);
  assert.equal(await store.claim(), null);
  const sent = [];
  const worker = createWorker({ store, documents: docs, feedback, decide, integrationFor: clinics.integration,
    crmFor: () => ({ kommo: { send: async (event, text) => sent.push(text) } })
  });
  await store.enqueue([{ ...event('clinic-observation', draft.id, 'draft-account', 'Tem estacionamento?'), provider: 'kommo' }]);
  await worker.tick();
  assert.deepEqual(sent, ['Orientação da clínica: Estacionamento gratuito na lateral.']);
});

test('retentativa de agendamento mantém a tarefa única e nunca envia o link antigo', async t => {
  const { clinics, store, db } = await fixture(t);
  const id = await clinics.save(clinicForm('ghl', 'erp'));
  await db.query("UPDATE sdr.clinicas SET agendamento_url='https://agenda.example.com/antiga' WHERE id=$1", [id]);
  const input = event('erp-legacy', id, 'erp');
  await store.enqueue([input]);
  const legacy = await store.claim();
  await store.plan(legacy, { kind: 'qualificar_agendamento' }, 'send');
  await store.fail(legacy, 'queued', 'retry');
  const actions = [];
  let attempts = 0;
  const worker = createWorker({ store, integrationFor: clinics.integration, decide: async () => assert.fail('decisão já persistida'),
    logger: { error() {} }, crmFor: () => ({
      ghl: {
        qualify: async () => assert.fail('oportunidade já movida'),
        handoff: async (input, reason) => actions.push(reason),
        send: async (input, text) => {
          attempts++;
          assert.equal(text, bookingHandoffReply);
          if (attempts === 1) throw Object.assign(new Error('Falha de envio'), { status: 403 });
        }
      }
    })
  });
  await worker.tick();
  assert.equal(attempts, 1);
  const [blocked] = await store.pending(id);
  assert.equal(blocked.step, 'send');
  assert.equal(await store.resume(id, leadKey(input)), false);
  assert.equal(await store.resolve(id, blocked.seq, 'tentar'), true);
  await worker.tick();
  assert.equal(attempts, 2);
  assert.equal(actions.length, 1);
  assert.match(actions[0], /agendamento no ERP/);
  assert.deepEqual(await store.pending(id), []);
  assert.equal(await store.paused(id, leadKey(input)), true);

  await store.enqueue([{ ...event('erp-sem-card', id, 'erp'), leadId: '101' }]);
  const withAmbiguity = createWorker({
    store, integrationFor: clinics.integration, decide: async () => ({ kind: 'qualificar_agendamento' }),
    crmFor: () => ({ ghl: {
      qualify: async () => { throw new OpportunityError(); },
      handoff: async (input, reason) => actions.push(reason),
      send: async (input, text) => assert.equal(text, bookingHandoffReply)
    } })
  });
  await withAmbiguity.tick();
  assert.match(actions[1], /agendamento no ERP.*Confira o card/);
  assert.deepEqual(await store.pending(id), []);
});
