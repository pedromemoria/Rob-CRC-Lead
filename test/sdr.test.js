import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { createKnowledge, safeReply } from '../src/knowledge.js';
import { createStore } from '../src/store.js';
import { createWorker } from '../src/worker.js';
import { createAgent, replies } from '../src/agent.js';
import { createApp } from '../src/server.js';
import { createCrms, OpportunityError } from '../src/crm.js';

const bookingUrl = 'https://agenda.example.com/consulta';

const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

async function database(dataDir) {
  const db = new PGlite(dataDir);
  const client = Object.assign(new EventEmitter(), { query: db.query.bind(db), release() {} });
  await db.exec(schema);
  return {
    query: client.query,
    connect: async () => client,
    close: () => db.close()
  };
}

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sdr-tests-'));
  const file = join(dir, 'faq.md');
  writeFileSync(file, '# FAQ\n');
  const db = await database();
  t.after(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file, knowledge: createKnowledge(dir, db), store: createStore(db) };
}

function modelResult(name, args) {
  return { choices: [{ message: { tool_calls: [{
    type: 'function', function: { name, arguments: JSON.stringify(args) }
  }] } }] };
}

test('o modelo só seleciona respostas publicadas e agendamento precisa de evidência', async t => {
  const { knowledge } = await fixture(t);
  let result;
  let requests = 0;
  const mock = { chat: { completions: { async create(request) {
    assert.equal(request.tool_choice, 'required');
    assert.equal(request.parallel_tool_calls, false);
    requests += 1;
    return result;
  } } } };
  const decide = createAgent({ model: 'gpt-4o' }, knowledge, mock);
  result = modelResult('responder', { resposta_id: 'https://malicioso.invalid' });
  assert.equal((await decide({ text: 'Oi' }, [])).text, replies.convidar);

  result = modelResult('qualificar_agendamento', { trecho: 'quero agendar' });
  assert.equal((await decide({ text: 'Eu quero agendar' }, [])).kind, 'qualificar_agendamento');
  assert.equal((await decide({ text: 'Eu não quero agendar' }, [])).kind, 'responder');
  assert.equal((await decide({ text: 'Oi' }, [])).kind, 'responder');
  result = modelResult('qualificar_agendamento', { trecho: 'Sim' });
  assert.equal((await decide({ text: 'Sim' }, [])).kind, 'responder');
  assert.equal((await decide({ text: 'Sim' }, [{ offered: 1 }])).kind, 'qualificar_agendamento');

  result = modelResult('responder', { resposta_id: 'acolher' });
  assert.equal((await decide({ text: 'Pode diagnosticar o meu caso?' }, [])).text, replies.avaliacao);
  assert.equal((await decide({ text: 'Quero falar com um humano' }, [])).kind, 'transbordo_humano');
  assert.equal((await decide({ text: 'Pare de me enviar mensagens' }, [])).reason, 'descadastro');
  assert.equal(requests, 7);

  const original = (await knowledge.files()).get('faq.md');
  await knowledge.save('faq.md', '# FAQ\n<!-- respostas:sdr -->\nvalor | A consulta custa R$ 120,00.\n<!-- fim:sdr -->\n',
    knowledge.revision(original));
  result = modelResult('responder', { resposta_id: 'valor' });
  assert.equal((await decide({ text: 'Qual o preço?' }, [])).text, 'A consulta custa R$ 120,00.');
  assert.equal(safeReply('Acesse teste.com'), false);
  assert.equal(safeReply('Acesse 127.0.0.1'), false);
  assert.equal(safeReply('Acesse ｈｔｔｐ．com'), false);
  assert.equal(safeReply('Acesse teste。com'), false);
});

test('webhooks reais do Express, validação de assinatura e edição autenticada', async t => {
  const { knowledge, file, store } = await fixture(t);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const adminToken = 'a'.repeat(64);
  const webhookToken = 'b'.repeat(64);
  const config = { adminToken, kommo: { webhookToken, accountId: '100', subdomain: 'demo' },
    ghl: { publicKey, locationId: 'branch' } };
  const server = createApp(config, store, knowledge).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;

  const ghlBody = JSON.stringify({
    type: 'InboundMessage', direction: 'inbound', locationId: 'branch', contactId: 'contact',
    messageId: 'ghi', conversationId: 'conv', messageTypeString: 'TYPE_WHATSAPP', body: 'Oi'
  });
  const signature = sign(null, Buffer.from(ghlBody), privateKey).toString('base64');
  const requestGhl = body => fetch(base + '/webhooks/ghl', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GHL-Signature': signature }, body
  });
  assert.equal((await requestGhl(ghlBody + ' ')).status, 401);
  assert.equal((await requestGhl(ghlBody)).status, 200);
  assert.equal((await requestGhl(ghlBody)).status, 200);

  const kommoForm = new URLSearchParams({
    'account[id]': '100', 'account[subdomain]': 'demo', 'message[add][0][id]': 'abc',
    'message[add][0][type]': 'incoming', 'message[add][0][author][type]': 'external',
    'message[add][0][entity_type]': 'lead', 'message[add][0][entity_id]': '110',
    'message[add][0][talk_id]': '111', 'message[add][0][text]': 'Oi'
  });
  const requestKommo = token => fetch(base + '/webhooks/kommo/' + token, { method: 'POST', body: kommoForm });
  assert.equal((await requestKommo('invalido')).status, 401);
  assert.equal((await requestKommo(webhookToken)).status, 200);
  kommoForm.set('message[add][0][id]', 'echo');
  kommoForm.set('message[add][0][type]', 'outgoing');
  assert.equal((await requestKommo(webhookToken)).status, 200);

  const ghlJob = await store.claim();
  assert.equal(ghlJob.event.channel, 'WhatsApp');
  await store.finish(ghlJob);
  const kommoJob = await store.claim();
  assert.equal(kommoJob.event.conversationId, '111');
  await store.finish(kommoJob);
  assert.equal(await store.claim(), null);

  const adminUrl = base + '/admin/treinar?arquivo=faq.md';
  assert.equal((await fetch(adminUrl)).status, 401);
  const headers = { Authorization: 'Basic ' + Buffer.from('admin:' + adminToken).toString('base64') };
  const html = await (await fetch(adminUrl, { headers })).text();
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
  const revision = html.match(/name="revision" value="([^"]+)"/)[1];
  const edit = (text, token = csrf) => fetch(adminUrl, {
    method: 'POST', headers, redirect: 'manual',
    body: new URLSearchParams({ _csrf: token, revision, texto: text })
  });
  assert.equal((await edit('Mudança', 'invalido')).status, 403);
  const content = '# FAQ\n</textarea><script>alert(1)</script>\n';
  assert.equal((await edit(content)).status, 303);
  assert.equal((await knowledge.files()).get('faq.md'), content);
  assert.equal(readFileSync(file, 'utf8'), '# FAQ\n');
  assert.equal((await edit('Versão antiga')).status, 422);
  const updated = await (await fetch(adminUrl, { headers })).text();
  assert.match(updated, /&lt;\/textarea&gt;&lt;script&gt;/);
  assert.doesNotMatch(updated, /<script>/);
});

function event(eventId, provider = 'ghl', text = 'Quero agendar') {
  return { provider, account: '1', leadId: '99', eventId, conversationId: '11', text };
}

test('fila move etapa antes de enviar, registra transbordo e deixa outros CRMs ativos', async t => {
  const { store } = await fixture(t);
  const actions = [];
  const crm = {
    async qualify(e) { actions.push(['qualify', e.provider]); },
    async send(e, text) { actions.push(['send', e.provider, text]); },
    async handoff(e) {
      assert.equal(await store.paused('ghl:1:99'), true);
      actions.push(['handoff', e.provider]);
    }
  };
  const decide = async e => e.text === 'Humano'
    ? { kind: 'transbordo_humano', reason: 'humano' } : { kind: 'qualificar_agendamento' };
  const worker = createWorker({ store, decide, crms: { kommo: crm, ghl: crm }, bookingUrl });
  await store.enqueue([event('1'), event('2', 'ghl', 'Humano'), event('3'), event('1', 'kommo')]);
  for (let i = 0; i < 4; i++) await worker.tick();
  assert.deepEqual(actions.map(action => action.slice(0, 2)), [
    ['qualify', 'ghl'], ['send', 'ghl'], ['handoff', 'ghl'], ['qualify', 'kommo'], ['send', 'kommo']
  ]);
  assert.equal(actions[1][2].split('\n')[1], bookingUrl);
  assert.equal(await store.resume('ghl:1:99'), true);
});

test('persistem treinamento, histórico, pausa, fila e deduplicação após reinício', async t => {
  const { dir } = await fixture(t);
  const file = join(dir, 'postgres');
  const original = await database(file);
  const before = createStore(original);
  const training = createKnowledge(dir, original);
  await training.save('faq.md', 'Texto publicado', training.revision('# FAQ\n'));
  await before.enqueue([event('1'), event('2'), event('3', 'kommo')]);
  const sent = await before.claim();
  await before.plan(sent, { kind: 'responder', offer: true }, 'send');
  await before.finish(sent, 'Quer receber o link?');
  const handoff = await before.claim();
  await before.plan(handoff, { kind: 'transbordo_humano', reason: 'humano' }, 'handoff');
  await before.startEffect(handoff);
  await original.close();

  const restarted = await database(file);
  t.after(() => restarted.close());
  const after = createStore(restarted);
  await after.withWorker(async worker => {
    assert.equal((await worker.pending())[0].state, 'uncertain');
  });
  assert.equal(await after.paused('ghl:1:99'), true);
  assert.equal((await createKnowledge(dir, restarted).files()).get('faq.md'), 'Texto publicado');
  assert.equal((await after.history(handoff))[0].offered, true);
  await after.enqueue([event('1')]);
  const outstanding = await after.claim();
  assert.equal(outstanding.event.eventId, '3');
  await after.finish(outstanding);
  assert.equal(await after.claim(), null);
  const [job] = await after.pending();
  assert.equal(await after.resolve(job.seq, 'tentar'), true);
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
