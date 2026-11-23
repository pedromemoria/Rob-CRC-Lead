import { Pool } from 'pg';

export function createPool({ url, ca }) {
  return new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 15000,
    query_timeout: 8000,
    keepAlive: true
  }).on('error', () => console.error('Conexão ociosa com o PostgreSQL interrompida'));
}

export async function transaction(database, operation) {
  const client = typeof database.connect === 'function' && typeof database.release !== 'function'
    ? await database.connect()
    : database;
  let unusable = false;
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      unusable = true;
    }
    throw error;
  } finally {
    if (client !== database) client.release(unusable);
  }
}
