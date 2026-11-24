import { timingSafeEqual, verify } from 'node:crypto';
import express from 'express';
import { hashWebhook } from './clinics.js';

const id = /^[A-Za-z0-9_-]{1,128}$/;
const numeric = /^[1-9]\d{0,14}$/;
const valid = (value, pattern = id) =>
  (typeof value === 'string' || Number.isSafeInteger(value)) && pattern.test(String(value));

export function equalSecret(received, expected) {
  if (typeof received !== 'string') return false;
  const supplied = Buffer.from(received);
  const trusted = Buffer.from(expected);
  return supplied.length === trusted.length && timingSafeEqual(supplied, trusted);
}

export function verifyGhl(raw, signature, key) {
  if (!Buffer.isBuffer(raw) || !/^[A-Za-z0-9+/]{86}==$/.test(signature ?? '')) return false;
  return verify(null, raw, key, Buffer.from(signature, 'base64'));
}

function messageText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 4000) : '';
}

export function kommoEvents(body, config) {
  const account = body?.account;
  if (String(account?.id) !== config.accountId || account?.subdomain !== config.subdomain) return [];
  const messages = body.message?.add;
  if (!Array.isArray(messages)) return [];
  return messages.filter(m =>
    m?.type === 'incoming' && m.author?.type === 'external' &&
    m.entity_type === 'lead' && valid(m.id) && valid(m.talk_id, numeric) &&
    valid(m.entity_id ?? m.element_id, numeric)
  ).map(m => ({
    provider: 'kommo', account: config.accountId,
    leadId: String(m.entity_id ?? m.element_id), eventId: String(m.id),
    conversationId: String(m.talk_id), text: messageText(m.text)
  }));
}

const ghlChannels = new Map([
  ['SMS', 'SMS'], ['WHATSAPP', 'WhatsApp'], ['IG', 'IG'], ['FB', 'FB'],
  ['LIVE_CHAT', 'Live_Chat'], ['LIVECHAT', 'Live_Chat'], ['CUSTOM', 'Custom']
]);

export function ghlEvents(body, config) {
  if (body?.type !== 'InboundMessage' || body.locationId !== config.locationId ||
      body.direction !== 'inbound' || !valid(body.contactId) || !valid(body.messageId) ||
      !valid(body.conversationId)) return [];
  const channel = [body.messageTypeString, body.messageType]
    .map(type => String(type ?? '').toUpperCase().replace(/^TYPE_/, ''))
    .map(type => ghlChannels.get(type)).find(Boolean);
  if (!channel || (channel === 'Custom' && !valid(body.conversationProviderId))) return [];
  return [{
    provider: 'ghl', account: config.locationId, leadId: String(body.contactId),
    conversationId: String(body.conversationId), eventId: String(body.messageId),
    channel, providerId: channel === 'Custom' ? String(body.conversationProviderId) : undefined,
    text: messageText(body.body)
  }];
}

export function webhooks(config, store, clinics) {
  const router = express.Router();
  router.post('/kommo/:clinicaId', async (req, res, next) => {
    if (!req.is('application/x-www-form-urlencoded')) return res.sendStatus(415);
    const token = req.query.token;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return res.sendStatus(401);
    const clinic = await clinics.routing(req.params.clinicaId);
    if (clinic?.crm_tipo !== 'kommo' || !equalSecret(hashWebhook(token), clinic.webhook_token_hash)) {
      return res.sendStatus(401);
    }
    res.locals.clinic = clinic;
    next();
  }, express.urlencoded({ extended: true, limit: '256kb', parameterLimit: 4000, depth: 8, inflate: false }),
  async (req, res) => {
    const clinic = res.locals.clinic;
    if (!clinic.ativo) return res.sendStatus(200);
    const events = kommoEvents(req.body, { accountId: clinic.kommo_conta_id, subdomain: clinic.crm_account_id });
    await store.enqueue(events.map(event => ({ ...event, clinicId: clinic.id })));
    res.sendStatus(200);
  });

  router.post('/ghl/:clinicaId', (req, res, next) => {
    if (!req.is('application/json')) return res.sendStatus(415);
    next();
  }, express.raw({ type: 'application/json', limit: '256kb', inflate: false }), async (req, res) => {
    if (!verifyGhl(req.body, req.get('X-GHL-Signature'), config.ghl.publicKey)) return res.sendStatus(401);
    let body;
    try {
      body = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.sendStatus(400);
    }
    const clinic = await clinics.routing(req.params.clinicaId);
    if (clinic?.crm_tipo !== 'ghl') return res.sendStatus(404);
    if (!clinic.ativo) return res.sendStatus(200);
    const events = ghlEvents(body, { locationId: clinic.crm_account_id });
    await store.enqueue(events.map(event => ({ ...event, clinicId: clinic.id })));
    res.sendStatus(200);
  });
  return router;
}
