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

  const adminToken = required('ADMIN_TOKEN', /^[A-Za-z0-9_-]{32,128}$/);
  const crmEncryptionKey = env.CRM_ENCRYPTION_KEY?.trim();
  if (crmEncryptionKey && !/^[0-9a-f]{64}$/i.test(crmEncryptionKey)) {
    throw new Error('CRM_ENCRYPTION_KEY deve ter 64 caracteres hexadecimais');
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
  return {
    port,
    host: env.HOST || '0.0.0.0',
    database: { url: databaseUrl, ca: env.DATABASE_SSL_CA?.replace(/\\n/g, '\n') },
    adminToken,
    crmEncryptionKey,
    openai: { apiKey: required('OPENAI_API_KEY'), model: env.OPENAI_MODEL || 'gpt-4o' },
    ghl: { version: env.GHL_API_VERSION || 'v3', publicKey }
  };
}
