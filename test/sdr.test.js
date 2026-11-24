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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore, leadKey } from '../src/store.js';
import { createWorker } from '../src/worker.js';
import { createAgent, replies } from '../src/agent.js';
import { createApp } from '../src/server.js';
import { createCrms, OpportunityError } from '../src/crm.js';

const bookingUrl = 'https://agenda.example.com/consulta';
const adminToken = 'a'.repeat(64);
const webhookToken = 'b'.repeat(64);
const templateDir = fileURLToPath(new URL('../knowledge/', import.meta.url));
const clinicForm = (type, account, fields = {}) => ({
  nome_clinica: 'Clínica ' + account, crm_tipo: type, crm_account_id: account,
  kommo_conta_id: '100', crm_token: 'token-secret-' + account, webhook_token: webhookToken,
  funil_id: '8', etapa_agendamento_id: '13', responsavel_id: '15',
  agendamento_url: bookingUrl, regras_negocio: '', quebra_objecoes: '', faq: '# FAQ\n', ...fields
});

const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

async function database(dataDir) {
  const db = new PGlite(dataDir);
  const client = Object.assign(new EventEmitter(), { query: db.query.bind(db), release() {} });
  await db.exec(schema);
  await db.exec(readFileSync(new URL('../supabase/multi-clinica.sql', import.meta.url), 'utf8'));
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
  const mock = { chat: { completions: { async create(request) {
    assert.equal(request.tool_choice, 'required');
    assert.equal(request.parallel_tool_calls, false);
    requests += 1;
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
  assert.equal((await decide({ text: 'Qual o preço?' }, [], knowledge)).text, 'A consulta custa R$ 120,00.');
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
  const server = createApp(config, store, clinics).listen(0, '127.0.0.1');
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
  assert.equal((await fetch(adminUrl)).status, 401);
  const headers = { Authorization: 'Basic ' + Buffer.from('admin:' + adminToken).toString('base64') };
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
  const editUrl = adminUrl + '?clinica=' + ghlId;
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
  const route = await clinics.routing(kommoId);
  assert.match(route.webhook_token_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(route.webhook_token_hash, webhookToken);
  await assert.rejects(clinics.save(clinicForm('ghl', 'branch')), /já está vinculada/);
  const updated = await (await fetch(editUrl, { headers })).text();
  assert.ok(updated.includes('&lt;/textarea&gt;&lt;script&gt;'));
  assert.doesNotMatch(updated, /<script>|token-secret-branch/);
});

function event(eventId, clinicId, account = 'branch', text = 'Quero agendar') {
  return { clinicId, provider: 'ghl', account, leadId: '99', eventId, conversationId: '11', text };
}

test('fila usa treinamento, credenciais, links, histórico e pausas de cada clínica', async t => {
  const { clinics, store } = await fixture(t);
  const faq = name => '<!-- respostas:sdr -->\nresposta | Conhecimento ' + name + '.\n<!-- fim:sdr -->';
  const first = await clinics.save(clinicForm('ghl', 'a', { faq: faq('Alfa') }));
  const secondBooking = 'https://outra.example.com/consulta';
  const second = await clinics.save(clinicForm('ghl', 'b', { faq: faq('Beta'), agendamento_url: secondBooking }));
  const actions = [];
  const crmFor = integration => ({
    ghl: {
      async qualify(e) { actions.push(['qualify', e.clinicId, integration.ghl.token]); },
      async send(e, text) { actions.push(['send', e.clinicId, text]); },
      async handoff(e) {
        assert.equal(await store.paused(e.clinicId, leadKey(e)), true);
        actions.push(['handoff', e.clinicId]);
      }
    }
  });
  const decide = async (e, history, training) => {
    assert.equal(training.replies.get('resposta'), e.clinicId === first ? 'Conhecimento Alfa.' : 'Conhecimento Beta.');
    if (e.eventId === '1') assert.deepEqual(history, []);
    return e.text === 'Humano'
      ? { kind: 'transbordo_humano', reason: 'humano' } : { kind: 'qualificar_agendamento' };
  };
  const worker = createWorker({ store, decide, integrationFor: clinics.integration, crmFor });
  const a = event('1', first, 'a');
  const b = event('1', second, 'b');
  await store.enqueue([a, event('2', first, 'a', 'Humano'), event('3', first, 'a'), b]);
  for (let i = 0; i < 4; i++) await worker.tick();
  assert.deepEqual(actions, [
    ['qualify', first, 'token-secret-a'],
    ['send', first, 'Perfeito! Escolha o melhor horário por aqui:\n' + bookingUrl],
    ['handoff', first],
    ['qualify', second, 'token-secret-b'],
    ['send', second, 'Perfeito! Escolha o melhor horário por aqui:\n' + secondBooking]
  ]);
  assert.equal(await store.resume(second, leadKey(a)), false);
  assert.equal(await store.resume(first, leadKey(a)), true);
  assert.equal(await store.paused(second, leadKey(b)), false);
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

  const restarted = await database(dir);
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
