import { createPublicKey } from 'node:crypto';
import dotenv from 'dotenv';

const ghlKey = 'MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=';

export function loadConfig() {
  dotenv.config({ quiet: true });
  const env = process.env;

  function required(name, pattern = /\S/) {
    const value = env[name]?.trim();
    if (!value || !pattern.test(value)) throw new Error('Configure ' + name);
    return value;
  }

  function numericId(name) {
    const value = Number(required(name, /^[1-9]\d{0,14}$/));
    return value;
  }

  const id = /^[A-Za-z0-9_-]{1,128}$/;
  const tokenPattern = /^[A-Za-z0-9_-]{32,128}$/;
  const adminToken = required('ADMIN_TOKEN', tokenPattern);
  const kommoWebhookToken = required('KOMMO_WEBHOOK_TOKEN', tokenPattern);
  if (adminToken === kommoWebhookToken) throw new Error('Use segredos distintos');
  const bookingUrl = required('AGENDAMENTO_URL');
  const parsedUrl = new URL(bookingUrl);
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || /[\s\\]/u.test(bookingUrl)) {
    throw new Error('Use uma AGENDAMENTO_URL HTTPS sem credenciais');
  }
  const publicKey = createPublicKey({
    key: Buffer.from(env.GHL_WEBHOOK_PUBLIC_KEY || ghlKey, 'base64'),
    format: 'der',
    type: 'spki'
  });
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Chave GHL inválida');
  const databaseUrl = required('DATABASE_URL');
  const database = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.username ||
      [...database.searchParams.keys()].some(key => /^ssl|^uselibpqcompat$/i.test(key))) {
    throw new Error('Configure DATABASE_URL com a URI PostgreSQL, sem parâmetros SSL');
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida');
  const kommoStageId = numericId('KOMMO_STAGE_QUALIFICADO_ID');
  if ([142, 143].includes(kommoStageId)) throw new Error('Configure uma etapa aberta no Kommo');

  return {
    port,
    host: env.HOST || '0.0.0.0',
    database: { url: databaseUrl, ca: env.DATABASE_SSL_CA?.replace(/\\n/g, '\n') },
    adminToken,
    bookingUrl,
    openai: { apiKey: required('OPENAI_API_KEY'), model: env.OPENAI_MODEL || 'gpt-4o' },
    kommo: {
      subdomain: required('KOMMO_SUBDOMAIN', /^[a-z0-9][a-z0-9-]{0,62}$/),
      accountId: String(numericId('KOMMO_ACCOUNT_ID')),
      token: required('KOMMO_ACCESS_TOKEN'),
      webhookToken: kommoWebhookToken,
      pipelineId: numericId('KOMMO_PIPELINE_ID'),
      stageId: kommoStageId,
      assignee: numericId('KOMMO_RESPONSAVEL_ID')
    },
    ghl: {
      token: required('GHL_ACCESS_TOKEN'),
      locationId: required('GHL_LOCATION_ID', id),
      pipelineId: required('GHL_PIPELINE_ID', id),
      stageId: required('GHL_STAGE_QUALIFICADO_ID', id),
      assignee: required('GHL_RESPONSAVEL_ID', id),
      version: env.GHL_API_VERSION || 'v3',
      publicKey
    }
  };
}
