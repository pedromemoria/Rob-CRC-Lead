import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const scryptOptions = { N: 32_768, r: 8, p: 3, maxmem: 40 * 1024 * 1024 };
export const emailFormat = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
export const normalizedEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
export const validEmail = value => value.length <= 254 && emailFormat.test(value);
const tokenPattern = /^[a-f0-9]{64}$/;
const hashInvitation = token => createHash('sha256').update(token).digest('hex');
export const minimumPasswordLength = 8;
const validPassword = password => typeof password === 'string' && password.length >= minimumPasswordLength &&
  password.length <= 256 && /\S/u.test(password);
const fakeHash = '0'.repeat(32) + '.' + '0'.repeat(128);

async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  const hash = await derive(password, salt, 64, scryptOptions);
  return salt + '.' + hash.toString('hex');
}

export function createAccounts(database) {
  return {
    async request(email) {
      await database.query('INSERT INTO sdr.admin_accounts(email) VALUES ($1) ON CONFLICT(email) DO NOTHING', [email]);
    },
    async list() {
      const { rows } = await database.query(
        'SELECT id,email,clinica_id,password_hash IS NOT NULL AS active,' +
        ' invitation_expires>now() AS invited FROM sdr.admin_accounts ORDER BY requested_at DESC,id LIMIT 200'
      );
      return rows;
    },
    async invite(id, clinicId) {
      const token = randomBytes(32).toString('hex');
      const result = await database.query(
        'UPDATE sdr.admin_accounts SET clinica_id=$2,invitation_hash=$3,' +
        " invitation_expires=now()+interval '48 hours' WHERE id=$1 AND password_hash IS NULL",
        [id, clinicId, hashInvitation(token)]
      );
      return result.rowCount === 1 ? token : null;
    },
    async activate(token, password) {
      if (typeof token !== 'string' || !tokenPattern.test(token) || !validPassword(password)) return false;
      const digest = hashInvitation(token);
      const exists = await database.query(
        'SELECT 1 FROM sdr.admin_accounts WHERE invitation_hash=$1 AND invitation_expires>now()', [digest]
      );
      if (!exists.rowCount) return false;
      const result = await database.query(
        'UPDATE sdr.admin_accounts SET password_hash=$2,invitation_hash=NULL,invitation_expires=NULL' +
        ' WHERE invitation_hash=$1 AND invitation_expires>now() AND clinica_id IS NOT NULL',
        [digest, await passwordHash(password)]
      );
      return result.rowCount === 1;
    },
    async authenticate(email, password) {
      if (!validEmail(email) || !validPassword(password)) return null;
      const { rows: [account] } = await database.query(
        'SELECT id,password_hash FROM sdr.admin_accounts WHERE email=$1 AND clinica_id IS NOT NULL', [email]
      );
      const expected = account?.password_hash ?? fakeHash;
      const computed = await passwordHash(password, expected.split('.')[0]);
      return timingSafeEqual(Buffer.from(computed), Buffer.from(expected)) && account?.password_hash ? account.id : null;
    },
    async revoke(id) {
      const result = await database.query(
        'DELETE FROM sdr.admin_accounts WHERE id=$1', [id]
      );
      return result.rowCount === 1;
    }
  };
}
