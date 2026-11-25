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
import { createDocuments, extractDocument, modelReferences } from '../src/documents.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore, leadKey } from '../src/store.js';
import { createWorker } from '../src/worker.js';
import { createAIProvider, providerFailureMessage } from '../src/ai-provider.js';
import { bookingCallbackToken } from '../src/booking.js';
import { salesReplies } from '../src/sales.js';
import { addAcknowledgment, bookingHandoffReply, bookingInterest, createAgent, distinctSentences, replies } from '../src/agent.js';
import { simulate, validHistory } from '../src/simulator.js';
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
    await db.exec(readFileSync(new URL('../supabase/agenda-autonoma.sql', import.meta.url), 'utf8'));
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
  let system;
  const mock = { chat: { completions: { async create(request) {
    assert.equal(request.tool_choice, 'required');
    assert.equal(request.parallel_tool_calls, false);
    requests += 1;
    system = request.messages[0].content;
    modelContext = JSON.parse(request.messages[1].content);
    return result;
  } } } };
  const decide = createAgent({ model: 'gpt-4o' }, mock);
  result = modelResult('responder', { resposta_id: 'https://malicioso.invalid' });
  assert.match((await decide({ text: 'Oi', leadName: 'Ana Pereira' }, [], knowledge)).text, /Oi, Ana!/);
  assert.match((await decide({ text: 'Eu quero agendar' }, [], knowledge)).text, /gostaria de melhorar/);
  assert.equal((await decide({ text: 'Eu não quero agendar' }, [], knowledge)).kind, 'responder');
  assert.equal((await decide({ text: 'Sim' }, [], knowledge)).kind, 'responder');
  assert.notEqual((await decide({ text: 'Sim' }, [{ offered: true }], knowledge)).text, salesReplies.turno);
  const offered = [{ outbound: salesReplies.turno, offered: true }];
  assert.deepEqual(await decide({
    text: 'Prefiro à tarde', contactName: 'Ana Pereira', contactPhone: '85999887766'
  }, offered, knowledge), {
    kind: 'qualificar_agendamento', turn: 'tarde', contactName: 'Ana Pereira', contactPhone: '85999887766'
  });
  assert.equal((await decide({ text: 'Pode diagnosticar o meu caso?' }, [], knowledge)).text, replies.avaliacao);
  assert.equal((await decide({ text: 'Quero falar com um humano' }, [], knowledge)).kind, 'transbordo_humano');
  assert.equal((await decide({ text: 'Pare de me enviar mensagens' }, [], knowledge)).reason, 'descadastro');
  assert.equal(requests, 9);

  clinic.faq = '# FAQ\n<!-- respostas:sdr -->\nvalor | A consulta custa R$ 120,00.\n<!-- fim:sdr -->\n';
  knowledge = clinicKnowledge(clinic);
  result = modelResult('responder', { resposta_id: 'valor' });
  const feedback = ['Priorize o preço publicado quando houver uma pergunta direta.'];
  assert.equal((await decide({ text: 'Qual o preço?' }, [], { ...knowledge, feedback })).text, salesReplies.preco_contexto);
  assert.equal((await decide({ text: 'Insisto, qual o preço?' }, [], knowledge)).text, salesReplies.sem_preco);
  await decide({ text: 'A consulta é presencial?' }, [], { ...knowledge, feedback });
  assert.ok(system.includes(feedback[0]));
  assert.equal(modelContext.respostas_disponiveis.valor, undefined);
  knowledge.replies.set('convite_antigo', 'Quer receber o link para escolher um horário?');
  knowledge.replies.set('questionario', 'Entendi. Qual seu nome? E seu telefone?');
  result = modelResult('responder', { resposta_id: 'convite_antigo' });
  const natural = await decide({ text: 'Queria saber sobre a consulta' }, [], knowledge);
  assert.match(natural.text, /Como posso ajudar/);
  assert.equal(modelContext.respostas_disponiveis.convite_antigo, undefined);
  assert.equal(modelContext.respostas_disponiveis.questionario, undefined);
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
    const sources = e.text === 'Humano' ? [] : [e.clinicId === first ? 'alfa.txt' : 'beta.txt'];
    assert.deepEqual(training.references.map(file => file.nome), sources);
    return e.text === 'Humano'
      ? { kind: 'transbordo_humano', reason: 'humano' } : { kind: 'qualificar_agendamento' };
  };
  await documents.save(first, await extractDocument({ originalname: 'alfa.txt', buffer: Buffer.from('Documento Alfa') }));
  await documents.save(second, await extractDocument({ originalname: 'beta.txt', buffer: Buffer.from('Documento Beta') }));
  const worker = createWorker({ store, decide, integrationFor: clinics.integration, crmFor, documents, feedback });
  const a = event('1', first, 'a', 'Quero agendar sobre Alfa');
  const b = event('1', second, 'b', 'Quero agendar sobre Beta');
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
  let searches = 0;
  const findDocs = docs.context;
  docs.context = (...args) => {
    searches++;
    return findDocs(...args);
  };
  const server = createApp({ adminToken, ghl: {} }, store, clinics, {
    documents: docs, feedback, decide: async (event, history, knowledge) => {
      const modelContext = await knowledge.loadContext?.() ?? knowledge;
      modelRefs = modelContext.references;
      modelFeedback = modelContext.feedback;
      modelClinicName = knowledge.clinicName;
      return { kind: 'responder', text: replies.convidar, offer: true, modelContext };
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
  assert.match(selectedSimulator, /Modo Simulação \(Sem IA\)/);
  assert.match(selectedSimulator, /name="include_documents" disabled/);
  const html = await (await fetch(site(first), { headers })).text();
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
  const trainingUrl = site(first).replace('aba=arquivos', 'aba=treinamento');
  const feedbackUrl = site(first).replace('aba=arquivos', 'aba=feedback');
  for (const url of [trainingUrl, feedbackUrl]) {
    const html = await (await fetch(url, { headers })).text();
    assert.match(html, /data-drop/);
  }
  assert.match(await (await fetch(trainingUrl, { headers })).text(), /Novo aprendizado/);
  const comment = 'Treino exclusivo da clínica. <script>teste</script>';
  const answer = 'O estacionamento fica ao lado da clínica.';
  const version = String((await clinics.get(first)).versao);
  const saveLearning = (tipo, conteudo, token = csrf) => fetch(trainingUrl, {
    method: 'POST', headers, redirect: 'manual', body: new URLSearchParams({
      _csrf: token, acao: 'novo_aprendizado', versao: version, tipo, conteudo
    })
  });
  assert.equal((await saveLearning('orientacao', comment, 'csrf-invalido')).status, 403);
  const saved = await saveLearning('orientacao', comment);
  assert.equal(saved.status, 303);
  assert.match(saved.headers.get('location'), /aba=treinamento&salvo=learning/);
  assert.equal((await saveLearning('resposta', 'Acesse https://exemplo.com')).status, 422);
  assert.equal((await saveLearning('resposta', answer)).status, 303);
  assert.equal((await saveLearning('resposta', 'Oferecemos estacionamento.')).status, 422);
  assert.match((await clinics.get(first)).faq, /O estacionamento fica ao lado da clínica/);
  assert.doesNotMatch((await clinics.get(second)).faq, /estacionamento/);
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

  const simulation = (id, withAI, text = 'Qual o horário aos sábados?', includeDocuments = true) => fetch(base + '/admin/simular?clinica=' + id, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ withAI, text, includeDocuments })
  });
  const noAI = await (await simulation(first, false)).json();
  assert.equal(noAI.reply, 'Atendemos aos sábados.');
  const parking = await (await simulation(first, false, 'Tem estacionamento?')).json();
  assert.equal(parking.reply, answer);
  assert.deepEqual(noAI.sources, []);
  assert.equal(noAI.feedbackCount, 0);
  assert.equal(searches, 0);
  const appointment = await (await simulation(first, false, 'Eu quero agendar de manhã')).json();
  assert.match(appointment.reply, /nome completo/);
  const withDocs = await (await simulation(first, true)).json();
  assert.deepEqual(withDocs.sources, ['atendimento.txt']);
  assert.deepEqual(modelFeedback, [comment]);
  assert.match(modelRefs[0].trecho, /sábados/);
  assert.equal(searches, 1);
  const withoutDocs = await (await simulation(first, true, 'Qual o horário aos sábados?', false)).json();
  assert.deepEqual(withoutDocs.sources, []);
  assert.equal(withoutDocs.feedbackCount, 1);
  assert.deepEqual(modelRefs, []);
  assert.equal(searches, 1);
  const quickAI = await fetch(base + '/admin/simular?modo=rapido', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ withAI: true, text: 'A consulta é presencial?', nome_clinica: 'Clínica first' })
  });
  assert.equal(quickAI.status, 200);
  assert.equal((await quickAI.json()).reply, replies.convidar);
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
  assert.equal(pricing.reply, salesReplies.preco_contexto);
  assert.equal(pricing.offered, false);
  const turn = await (await quick('Clínica de teste', 'Quero agendar uma consulta de urologia')).json();
  assert.equal(turn.reply, salesReplies.turno);
  const appointment = await (await quick('Clínica de teste', 'À tarde', [{
    inbound: 'Quero agendar uma consulta de urologia', outbound: turn.reply, offered: turn.offered
  }])).json();
  assert.match(appointment.reply, /nome completo/);
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
  let modelSystem;
  let selected = 'valor';
  const decide = createAgent({ model: 'gpt-4o' }, { chat: { completions: { async create(request) {
    modelSystem = request.messages[0].content;
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
  assert.equal((await sim(first, 'Quanto custa a consulta inicial?')).reply, salesReplies.preco_contexto);
  const authorizedPrice = 'Entendo que o valor seja importante. Consulta inicial: R$ 150 a R$ 200. O cadastro informa: Consulta presencial.';
  assert.equal((await sim(first, 'Insisto, quanto custa a consulta inicial?')).reply, authorizedPrice);
  assert.equal((await sim(first, 'Insisto, quanto custa a consulta inicial?', true)).reply, authorizedPrice);
  await sim(first, 'Pode mandar o Google Maps?', true);
  assert.equal(modelContext.dados_da_clinica.contato.maps_url, values.maps_url);
  assert.ok(modelSystem.includes('Orientação da primeira clínica'));
  assert.equal((await sim(first, 'Qual o WhatsApp da recepção?')).reply, 'Telefone ou WhatsApp da recepção: (85) 98888-1234');
  assert.equal((await sim(first, 'Qual o CRM da Dra. Ana Silva?')).reply, 'Profissional: Dra. Ana Silva · Urologia · CRM-CE 12345');
  assert.equal((await sim(first, 'Pode mandar o Google Maps?')).reply, 'Endereço: Rua das Flores, 120');
  assert.doesNotMatch((await sim(second, 'Insisto, quanto custa a consulta inicial?', true)).reply, /150|200/);
  await sim(second, 'Pode mandar o Google Maps?', true);
  assert.deepEqual(modelContext.dados_da_clinica, {});
  selected = 'cadastro_servico_0_valor';
  assert.equal((await sim(first, 'Insisto, quanto custa o implante?', true)).reply, salesReplies.sem_preco);
  const integration = await clinics.integration(first);
  assert.equal(integration.knowledge.clinicData.contato.endereco, values.endereco);
  const sent = [];
  selected = 'valor';
  const worker = createWorker({ store, documents: docs, feedback: notes, decide, integrationFor: clinics.integration,
    crmFor: () => ({ ghl: { send: async (event, text) => sent.push(text) } })
  });
  await store.enqueue([event('structured-data', first, 'first-data', 'Insisto, quanto custa a consulta inicial?')]);
  await worker.tick();
  assert.deepEqual(sent, [authorizedPrice]);

  await store.enqueue([event('structured-retry', first, 'first-data', 'Insisto, quanto custa a consulta inicial?')]);
  const retry = await store.claim();
  await store.plan(retry, { kind: 'responder', text: authorizedPrice }, 'send');
  await store.fail(retry, 'queued', 'retry');
  assert.equal((await save({ versao: String((await clinics.get(first)).versao), serv_valor: 'R$ 220' })).status, 303);
  await worker.tick();
  assert.deepEqual(sent, [authorizedPrice, authorizedPrice.replace('R$ 150 a R$ 200', 'R$ 220')]);
});

test('clínica criada só com nome pode ser treinada e simulada antes de conectar o CRM', async t => {
  const { clinics, db, store } = await fixture(t);
  let modelContext;
  let modelSystem;
  const decide = createAgent({ model: 'gpt-4o' }, { chat: { completions: { async create(request) {
    modelSystem = request.messages[0].content;
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
  assert.ok(modelSystem.includes('Acolha com cuidado.'));
  assert.match((await sim('Quero agendar de manhã')).reply, /nome completo/);
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
    store, integrationFor: clinics.integration, decide: async () => ({ kind: 'qualificar_agendamento', turn: 'manhã', contactName: 'Ana Pereira', contactPhone: '85999887766' }),
    crmFor: () => ({ ghl: {
      qualify: async () => { throw new OpportunityError(); },
      handoff: async (input, reason) => actions.push(reason),
      send: async (input, text) => assert.equal(text, bookingHandoffReply)
    } })
  });
  await withAmbiguity.tick();
  assert.match(actions[1], /agendamento no ERP.*manhã.*Ana Pereira.*85999887766.*Confira o card/);
  assert.deepEqual(await store.pending(id), []);
});

test('simulador conduz as etapas do SPIN e respeita objeções antes do encaminhamento', async () => {
  const knowledge = { ...clinicKnowledge(clinicForm('ghl', 'spin')), references: [] };
  const history = [];
  const send = async text => {
    const reply = await simulate({ text, history, withAI: false, knowledge });
    assert.ok((reply.reply.match(/\?/g)?.length ?? 0) <= 1);
    history.push({ inbound: text, outbound: reply.reply, offered: reply.offered });
    return reply;
  };

  assert.match((await send('Oi')).reply, /Como posso ajudar/);
  assert.equal((await send('Quero saber mais sobre o atendimento.')).reply, salesReplies.situacao);
  assert.equal((await send('Para mim.')).reply, salesReplies.problema);
  assert.equal((await send('Isso tem me incomodado.')).reply, salesReplies.impacto);
  assert.equal((await send('Tem atrapalhado minha rotina.')).reply, salesReplies.necessidade);
  assert.equal((await send('Vou pensar e conversar com minha esposa.')).reply, salesReplies.pensar);
  assert.match((await send('Quero agendar.')).reply, /especialidade ou objetivo/);
  assert.equal((await send('Urologia')).reply, salesReplies.turno);
  assert.match((await send('Não posso de manhã, prefiro à tarde.')).reply, /nome completo/);
  assert.match((await send('Ana Pereira')).reply, /telefone ou WhatsApp/);
  assert.equal((await send('85999887766')).action, 'Encaminhar para agendamento no ERP · tarde');

  const withObjection = await simulate({ text: 'Não tenho tempo agora', history: [], withAI: false, knowledge });
  assert.equal(withObjection.reply, salesReplies.tempo);
  assert.doesNotMatch(withObjection.reply, /minutos|disponibilidade|pré-reserv/i);
});

test('aceites curtos retomam o fechamento, pedem dados um por vez e não repetem respostas', async () => {
  const approved = 'A recepção funciona aos sábados.';
  const knowledge = { ...clinicKnowledge(clinicForm('ghl', 'fechamento')), references: [] };
  knowledge.replies.set('horario', approved);
  const mock = { chat: { completions: { async create() {
    return modelResult('responder', { resposta_id: 'horario' });
  } } } };
  const decide = createAgent({ model: 'gpt-4o' }, mock);
  const invited = { inbound: 'Isso afeta minha rotina', outbound: salesReplies.necessidade, offered: true };
  const previousLoop = { inbound: 'Pode ser', outbound: 'Claro, eu posso ajudar.\nEntendo. Se quiser conversar mais sobre a avaliação, fico à disposição.', offered: false };

  for (const withAI of [false, true]) {
    for (const text of ['faz sim', 'quero', 'pode ser', 'por favor', 'faz sim, por favor', 'Quero fazer a avaliação']) {
      const answer = await simulate({ text, history: [invited, previousLoop], withAI, knowledge, decide });
      assert.equal(answer.reply, salesReplies.turno);
    }

    const history = [invited];
    const add = async text => {
      const answer = await simulate({ text, history, withAI, knowledge, decide });
      assert.notEqual(answer.reply, history.at(-1).outbound);
      history.push({ inbound: text, outbound: answer.reply, offered: answer.offered });
      return answer;
    };
    assert.equal((await add('faz sim')).reply, salesReplies.turno);
    assert.match((await add('Sim')).reply, /manhã ou tarde/);
    assert.match((await add('À tarde')).reply, /nome completo/);
    assert.match((await add('Ana')).reply, /nome e sobrenome/);
    assert.match((await add('Ana')).reply, /nome completo/);
    assert.match((await add('Ana Pereira')).reply, /telefone ou WhatsApp/);
    assert.match((await add('123')).reply, /melhor número/);
    assert.equal((await add('(85) 99988-7766')).action, 'Encaminhar para agendamento no ERP · tarde');

    const sameFact = await simulate({ text: 'Que horário aos sábados?', history: [
      { inbound: 'Que horário aos sábados?', outbound: approved, offered: false }
    ], withAI, knowledge, decide });
    assert.notEqual(sameFact.reply, approved);
  }
  const noAcceptance = await decide({ text: 'faz sim' }, [{ ...invited, outbound: 'A recepção fica aberta até as seis.', offered: false }], knowledge);
  assert.notEqual(noAcceptance.text, salesReplies.turno);
  const noBookingGoal = await simulate({ text: 'Eu procuro atendimento em urologia', history: [], withAI: false, knowledge });
  assert.match(noBookingGoal.reply, /busca atendimento em urologia/);
});

test('Gemini recebe contexto e chama a OpenAI somente quando o provedor principal falha', async () => {
  const knowledge = { ...clinicKnowledge(clinicForm('ghl', 'ai')), feedback: ['Atenda com empatia.'],
    references: [{ nome: 'Guia.pdf', trecho: 'Atendimento da clínica.' },
      { nome: 'Grande.txt', trecho: '"\n'.repeat(12_000) }] };
  let responseStatus = 200;
  const models = [];
  let fallbackCalls = 0;
  const fetcher = async (url, request) => {
    assert.ok(url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/'));
    models.push(url.split('/').at(-1));
    assert.equal(request.headers['x-goog-api-key'], 'gemini-for-test');
    const body = JSON.parse(request.body);
    const context = JSON.parse(body.contents[0].parts[0].text);
    const training = JSON.parse(body.systemInstruction.parts[0].text.split('Treinamento da clínica (referência):\n')[1]);
    assert.deepEqual(training.feedbacks_da_clinica, ['Atenda com empatia.']);
    assert.equal(training.documentos_de_referencia[0].nome, 'Guia.pdf');
    assert.equal(context.historico.length, 15);
    assert.deepEqual(context.historico[0], { papel: 'sdr', texto: 'Retorno 12' });
    assert.deepEqual(context.historico.at(-1), { papel: 'sdr', texto: 'Retorno 19' });
    assert.ok(JSON.stringify(training.documentos_de_referencia).length <= 12_000);
    assert.equal(body.toolConfig.functionCallingConfig.mode, 'ANY');
    assert.deepEqual(body.generationConfig, { temperature: 0.7, maxOutputTokens: 1500, thinkingConfig: { thinkingLevel: 'LOW' } });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [
      { functionCall: { name: 'conversar', args: { acolhimento: 'Imagino que encontrar o atendimento certo seja importante para você' } } }
    ] } }] }), { status: responseStatus });
  };
  const fallback = { chat: { completions: { async create() {
    fallbackCalls++;
    return modelResult('responder', { resposta_id: 'acolher' });
  } } } };
  const config = { geminiKey: 'gemini-for-test', openai: { model: 'gpt-4o' } };
  const decide = createAgent(config.openai, createAIProvider(config, { fetcher, fallback }));
  const history = Array.from({ length: 20 }, (_, index) => ({ inbound: 'Estou pesquisando', outbound: 'Retorno ' + index }));
  const primary = await decide({ text: 'Estou procurando atendimento para um familiar' }, history, knowledge);
  assert.match(primary.text, /encontrar o atendimento certo/);
  assert.equal(primary.model, 'gemini-3.6-flash');
  assert.equal(fallbackCalls, 0);
  responseStatus = 429;
  assert.equal((await decide({ text: 'Estou procurando atendimento para um familiar' }, history, knowledge)).text, replies.acolher);
  assert.deepEqual(models, ['gemini-3.6-flash:generateContent', 'gemini-3.6-flash:generateContent', 'gemini-3-flash-preview:generateContent']);
  assert.equal(fallbackCalls, 1);
  await decide({ text: 'Estou procurando atendimento para um familiar' }, history, knowledge);
  assert.equal(models.length, 3);
  assert.equal(fallbackCalls, 2);
  const onlyGemini = createAgent(config.openai, createAIProvider(config, { fetcher }));
  await assert.rejects(onlyGemini({ text: 'Estou procurando atendimento para um familiar' }, history, knowledge),
    error => error.status === 429);
});

test('GoHighLevel reserva um horário verificado e atualiza a oportunidade uma única vez', async t => {
  const { clinics, store } = await fixture(t);
  const id = await clinics.save(clinicForm('ghl', 'calendar', { calendarId: 'cal123', duration: '30', timezone: 'America/Fortaleza', bookingLink: 'https://reservas.example.org/agenda' }));
  const starts = [new Date(Date.now() + 86_400_000).toISOString(), new Date(Date.now() + 172_800_000).toISOString()];
  const events = [];
  const crmFor = config => createCrms(config, () => ({
    async get(path) {
      if (path === '/calendars/cal123/free-slots') return { data: { '2027-01-02': { slots: starts } } };
      assert.equal(path, '/opportunities/search');
      return { data: { opportunities: [{ id: 'opp', locationId: 'calendar', pipelineId: '8', status: 'open',
        contactId: '99', pipelineStageId: 'old' }] } };
    },
    async put(path, payload) { events.push(['stage', path, payload]); return { data: {} }; },
    async post(path, payload) {
      if (path === '/calendars/events/appointments') {
        events.push(['book', payload]);
        return { data: { id: 'appointment', ...payload } };
      }
      assert.equal(path, '/conversations/messages');
      events.push(['send', payload.message]);
      return { data: {} };
    }
  }));
  const decide = async () => ({ kind: 'qualificar_agendamento', turn: 'tarde', acknowledgment: 'Claro, vou verificar' });
  const styled = [];
  decide.styleReply = async text => {
    styled.push(text);
    return { text: 'Que bom poder ajudar. ' + text, provider: 'Gemini' };
  };
  const worker = createWorker({ store, integrationFor: clinics.integration, crmFor, decide });
  await store.enqueue([event('find', id, 'calendar')]);
  await worker.tick();
  assert.match(events[0][1], /1\..*\n2\./);
  await store.enqueue([event('choose', id, 'calendar', '1')]);
  await worker.tick();
  assert.deepEqual(events.map(x => x[0]), ['send', 'book', 'stage', 'send']);
  assert.equal(events[1][1].ignoreFreeSlotValidation, false);
  assert.equal(events[1][1].contactId, '99');
  assert.match(events[0][1], /^Claro, vou verificar/);
  assert.match(events[3][1], /^Que bom poder ajudar\. Sua avaliação está confirmada/);
  assert.equal(styled.length, 1);
  assert.equal(await store.paused(id, leadKey(event('choose', id, 'calendar'))), false);

  starts.length = 0;
  await store.enqueue([event('no-slots', id, 'calendar')]);
  await worker.tick();
  assert.equal(events.at(-1)[0], 'send');
  assert.match(events.at(-1)[1], /reservas\.example\.org\/agenda\?crc_ref=/);
  assert.equal(events.filter(entry => entry[0] === 'stage').length, 1);
});

test('agenda externa só move o card após confirmação autenticada e correlacionada', async t => {
  const { clinics, store, db } = await fixture(t);
  const id = await clinics.save(clinicForm('kommo', 'example', { bookingLink: 'https://reservas.example.org/agenda' }));
  const steps = [];
  const worker = createWorker({ store, integrationFor: clinics.integration,
    crmFor: () => ({ kommo: { send: async (_, text) => steps.push(text), qualify: async () => steps.push('movido') } }),
    decide: async () => ({ kind: 'qualificar_agendamento' }) });
  await store.enqueue([{ ...event('external', id, 'example'), provider: 'kommo' }]);
  await worker.tick();
  assert.equal(steps.length, 1);
  const reference = new URL(steps[0].split('\n').at(-1)).searchParams.get('crc_ref');
  const server = createApp({ adminToken, ghl: {} }, store, clinics, {
    documents: createDocuments(db), feedback: createFeedback(db), sessions: createSessions(db)
  }).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port + '/webhook/agenda/' + id;
  const token = bookingCallbackToken(adminToken, id);
  const confirm = (header, ref = reference) => fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + header },
    body: JSON.stringify({ reference: ref, appointmentId: 'appt-01', status: 'confirmed' })
  });
  assert.equal((await confirm('invalid')).status, 401);
  assert.equal((await confirm(token, 'a'.repeat(32))).status, 404);
  assert.equal((await confirm(token)).status, 202);
  assert.equal((await confirm(token)).status, 202);
  await worker.tick();
  await worker.tick();
  assert.deepEqual(steps.slice(1), ['movido']);
});

test('simulador aceita a escolha entre dois horários fictícios', async () => {
  const booking = { calendarId: 'test', timezone: 'America/Fortaleza', duration: 30 };
  const knowledge = { ...clinicKnowledge(clinicForm('ghl', 'sim-agenda')), references: [] };
  const decide = async () => ({ kind: 'qualificar_agendamento', turn: 'manhã' });
  const offer = await simulate({ text: 'Dados completos', history: [], knowledge, withAI: true, decide, booking });
  assert.equal(offer.agenda_ofertada.length, 2);
  const history = validHistory([{ inbound: 'Dados completos', outbound: offer.reply, agenda_ofertada: offer.agenda_ofertada }]);
  const clarification = await simulate({ text: 'Opção 3', history, knowledge, withAI: false, booking });
  assert.match(clarification.reply, /Responda 1 ou 2/);
  history.push({ inbound: 'Opção 3', outbound: clarification.reply, agenda_ofertada: clarification.agenda_ofertada });
  const selection = await simulate({ text: '2', history, knowledge, withAI: false, booking });
  assert.match(selection.reply, /Reserva simulada/);
});

test('IA participa da saudação com os documentos habilitados', async () => {
  const references = [{ nome: 'Manual.pdf', trecho: 'Horários da clínica' }];
  let calls = 0;
  const knowledge = { ...clinicKnowledge(clinicForm('ghl', 'sources')),
    loadContext: async () => ({ references, feedback: [] }) };
  const decide = createAgent({ model: 'test' }, { chat: { completions: { async create(request) {
    calls++;
    assert.equal(JSON.parse(request.messages[1].content).mensagem_atual, 'Oi');
    return { ...modelResult('conversar', { acolhimento: 'Olá, que bom receber você' }), provider: 'Gemini' };
  } } } });
  const answer = await simulate({ text: 'Oi', history: [], knowledge, withAI: true, decide });
  assert.match(answer.reply, /que bom receber você.*Como posso ajudar/);
  assert.deepEqual(answer.sources, ['Manual.pdf']);
  assert.equal(answer.provider, 'Gemini');
  assert.equal(calls, 1);
});

test('desejo agendar aciona a IA e mantém a pergunta de fechamento validada', async () => {
  const knowledge = { ...clinicKnowledge(clinicForm('ghl', 'intent')), references: [] };
  let calls = 0;
  const decide = createAgent({ model: 'test' }, { chat: { completions: { async create() {
    calls++;
    return { ...modelResult('conversar', { acolhimento: 'Claro, posso te ajudar com isso' }), provider: 'Gemini' };
  } } } });
  for (const withAI of [true, false]) {
    const message = await simulate({ text: 'DESEJO AGENDAR UMA CONSULTA', withAI, history: [], knowledge, decide });
    assert.match(message.reply, withAI ? /gostaria de melhorar/ : /especialidade ou objetivo/);
    assert.equal(message.provider, withAI ? 'Gemini' : undefined);
  }
  assert.equal(calls, 1);
  assert.equal(bookingInterest('Não desejo agendar uma consulta', []), false);
});

test('conversa consultiva usa o treinamento e confirma interesse antes de coletar dados', async () => {
  const knowledge = { ...clinicKnowledge(clinicForm('ghl', 'nutro', {
    regras_negocio: 'Na Nutrologia, entenda primeiro o objetivo dentro da especialidade.'
  })), feedback: ['Acolha frustração com tentativas anteriores.'],
  references: [{ nome: 'Nutrologia.pdf', trecho: 'Pergunte se o objetivo é emagrecimento ou disposição.' }] };
  knowledge.replies.set('avaliacao_nutro', 'Na avaliação, a conversa inclui seus hábitos e objetivos.');
  const decide = createAgent({ model: 'test' }, { chat: { completions: { async create(request) {
    const context = JSON.parse(request.messages[1].content);
    if (context.etapa_consultiva) {
      assert.match(request.messages[0].content, /entenda primeiro o objetivo/);
      assert.match(request.messages[0].content, /Acolha frustração/);
      assert.match(request.messages[0].content, /Nutrologia.pdf/);
    }
    if (context.etapa_consultiva === 'objetivo') return modelResult('explorar', {
      acolhimento: 'Imagino que seja importante encontrar um atendimento que faça sentido para você',
      pergunta: 'O que você busca na Nutrologia, emagrecer ou ganhar disposição?'
    });
    if (context.etapa_consultiva === 'dificuldade') return modelResult('explorar', {
      acolhimento: 'Entendo a importância desse objetivo para você',
      pergunta: 'O que costuma dificultar suas tentativas no dia a dia?'
    });
    if (context.etapa_consultiva === 'avaliacao') return modelResult('conectar', {
      acolhimento: 'Imagino como pode ser frustrante tentar tantas vezes',
      diferencial_id: 'avaliacao_nutro'
    });
    return modelResult('conversar', { acolhimento: '' });
  } } } });
  const history = [];
  const send = async text => {
    const result = await decide({ text }, history, knowledge);
    history.push({ inbound: text, outbound: result.text, offered: result.offer });
    assert.doesNotMatch(result.text, /Combinado|Já registrei|encaminhar|localizar o cadastro/i);
    return result;
  };
  const first = await send('Quero agendar Nutrologia');
  assert.match(first.text, /emagrecer ou ganhar disposição/);
  assert.doesNotMatch(first.text, /horário|turno|nome completo/);
  assert.match((await send('Quero emagrecer')).text, /dificultar suas tentativas/);
  const invite = await send('Já tentei várias vezes e isso me frustra');
  assert.match(invite.text, /frustrante.*hábitos e objetivos.*Quer marcar a avaliação/);
  assert.equal(invite.offer, true);
  assert.match((await send('Pode ser')).text, /manhã ou à tarde/);
  assert.match((await send('À tarde')).text, /qual é seu nome completo/i);
});

test('acolhimento evita repetir frases da resposta ou de mensagens anteriores', async () => {
  const acknowledgment = 'Imagino como é importante encontrar o atendimento certo';
  const followUp = 'Combinado. Prefere que a equipe verifique horários de manhã ou à tarde?';
  const history = [
    { outbound: 'Oi! IMAGINO como é importante encontrar o atendimento certo. Como posso ajudar?' },
    { outbound: 'Tudo bem. Que tipo de consulta você procura?' }
  ];
  assert.equal(addAcknowledgment(followUp, acknowledgment, history), followUp);
  assert.equal(addAcknowledgment('Claro, posso ajudar a agendar. Qual especialidade você procura?',
    'Claro, que bom poder orientar você'), 'Claro, posso ajudar a agendar. Qual especialidade você procura?');
  assert.equal(addAcknowledgment(followUp, acknowledgment), acknowledgment + '.\n' + followUp);

  const decide = createAgent({ model: 'test' }, { chat: { completions: { async create() {
    return modelResult('conversar', { acolhimento: acknowledgment });
  } } } });
  const reply = await decide.styleReply('Sua avaliação está confirmada.', history);
  assert.equal(reply.text, 'Sua avaliação está confirmada.');
});

test('simulador remove qualquer frase duplicada dentro de uma resposta', async () => {
  const duplicated = 'A Dra. Silva atende de manhã. A Dra. Silva atende de manhã.\n' +
    'A Dra. Melo atende à tarde.\nA DRA. MELO ATENDE À TARDE!\nQual turno funciona melhor?';
  const expected = 'A Dra. Silva atende de manhã.\nA Dra. Melo atende à tarde.\nQual turno funciona melhor?';
  assert.equal(distinctSentences(duplicated), expected);
  assert.equal(distinctSentences('A recepção abre às 8. A recepção abre às 8.'), 'A recepção abre às 8.');

  const withAgenda = 'Encontrei estas opções na agenda:\n1. quarta às 10h\n2. sexta às 10h\nQual opção você prefere?';
  assert.equal(distinctSentences(withAgenda), withAgenda);

  const knowledge = { ...clinicKnowledge(clinicForm('ghl', 'frase-duplicada')), references: [] };
  const decide = async () => ({ kind: 'responder', text: duplicated });
  const result = await simulate({ text: 'Quais são os horários?', history: [], knowledge, withAI: true, decide });
  assert.equal(result.reply, expected);

  knowledge.replies.set('recepcao', 'A recepção abre às oito. A recepção abre às oito.');
  const offline = await simulate({ text: 'Recepção', history: [], knowledge, withAI: false });
  assert.equal(offline.reply, 'A recepção abre às oito.');
});

test('IA participa do agendamento inteiro e preserva o horário e os dados privados', async () => {
  const booking = { calendarId: 'test', timezone: 'America/Fortaleza', duration: 30 };
  const knowledge = { ...clinicKnowledge(clinicForm('ghl', 'ai-conversa')), references: [] };
  const calls = [];
  const decide = createAgent({ model: 'test' }, { chat: { completions: { async create(request) {
    calls.push(JSON.parse(request.messages[1].content));
    return { ...modelResult('conversar', { acolhimento: 'Claro, vou ajudar com isso' }), provider: 'Gemini' };
  } } } });
  const history = [];
  const send = async text => {
    const result = await simulate({ text, history, knowledge, withAI: true, decide, booking });
    history.push({ inbound: text, outbound: result.reply, offered: result.offered, agenda_ofertada: result.agenda_ofertada });
    assert.equal(result.provider, 'Gemini');
    return result;
  };
  assert.match((await send('Oi')).reply, /Como posso ajudar/);
  assert.match((await send('Quero agendar de manhã')).reply, /gostaria de melhorar/);
  assert.match((await send('Quero emagrecer')).reply, /sido mais difícil/);
  assert.match((await send('Já tentei emagrecer e fico frustrada')).reply, /Quer marcar a avaliação/);
  assert.match((await send('Sim, de manhã')).reply, /nome completo/);
  assert.match((await send('Ana Pereira')).reply, /telefone ou WhatsApp/);
  const offered = await send('85999887766');
  assert.equal(offered.agenda_ofertada.length, 2);
  assert.match(offered.reply, /Encontrei estas opções na agenda/);
  const booked = await send('1');
  assert.ok(booked.reply.includes(offered.agenda_ofertada[0].text));
  assert.equal(calls.length, 8);
  assert.doesNotMatch(JSON.stringify(calls), /Ana Pereira|85999887766/);
});

test('diagnóstico da IA identifica os provedores sem expor dados do erro original', async () => {
  const provider = createAIProvider({ geminiKey: 'gemini-test-secret', openai: {} }, {
    fetcher: async () => new Response(JSON.stringify({ error: { details: [{ reason: 'API_KEY_INVALID' }],
      message: 'gemini-test-secret' } }), { status: 400 }),
    fallback: { chat: { completions: { async create() {
      throw Object.assign(new Error('openai-test-secret'), { status: 429, code: 'insufficient_quota' });
    } } } }
  });
  const request = { messages: [{ content: '' }, { content: '' }], tools: [] };
  await assert.rejects(provider.chat.completions.create(request), error => {
    const message = providerFailureMessage(error);
    assert.equal(error.status, 429);
    assert.match(message, /Gemini \(400, chave recusada\)/);
    assert.match(message, /OpenAI \(429, cota ou créditos insuficientes\)/);
    assert.doesNotMatch(message, /test-secret/);
    return true;
  });
});

test('modelo Gemini indisponível tenta outro Gemini antes de usar a OpenAI', async () => {
  const modelCalls = [];
  const provider = createAIProvider({ geminiKey: 'test-key', geminiModel: 'gemini-2.5-flash', openai: {} }, {
    fetcher: async url => {
      const model = url.split('/').at(-1);
      modelCalls.push(model);
      if (model.startsWith('gemini-2.5-flash:')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [
        { functionCall: { name: 'conversar', args: { acolhimento: 'Entendo a sua dúvida' } } }
      ] } }] }), { status: 200 });
    },
    fallback: { chat: { completions: { create: async () => assert.fail('Segundo Gemini disponível') } } }
  });
  const request = { messages: [{ content: '' }, { content: '' }], tools: [{
    function: { name: 'conversar', parameters: { required: ['acolhimento'], properties: { acolhimento: { type: 'string' } } } }
  }] };
  const result = await provider.chat.completions.create(request);
  assert.equal(result.provider, 'Gemini');
  assert.equal(result.model, 'gemini-3.6-flash');
  assert.deepEqual(modelCalls, ['gemini-2.5-flash:generateContent', 'gemini-3.6-flash:generateContent']);
});

test('trechos de documentos respeitam o orçamento mesmo com aspas e quebras de linha', () => {
  const references = modelReferences(Array.from({ length: 5 }, (_, index) => ({
    nome: 'Fonte ' + index, trecho: '"\n'.repeat(24_000)
  })));
  assert.ok(references[0].trecho);
  assert.ok(references.length < 5);
  assert.ok(JSON.stringify(references).length <= 12_000);
});
