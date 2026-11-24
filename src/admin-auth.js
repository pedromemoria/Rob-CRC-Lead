import { createHmac, randomBytes } from 'node:crypto';
import { equalSecret } from './webhooks.js';
import { normalizedEmail } from './accounts.js';
import { loginPage } from './admin-view.js';

const fallbackEmail = 'admin@robocrc.local';
const cookieName = '__Host-crc_session';
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };
const maxAge = 8 * 60 * 60 * 1_000;
const tokenPattern = /^[a-f0-9]{64}$/;

export function createSessions(database) {
  return {
    async save(hash, accountId) {
      await database.query('DELETE FROM sdr.admin_sessions WHERE expires_at <= now()');
      await database.query("INSERT INTO sdr.admin_sessions(token_hash,expires_at,account_id) VALUES ($1,now() + interval '8 hours',$2)", [hash, accountId]);
    },
    async read(hash) {
      const { rows } = await database.query(
        'SELECT s.account_id,a.clinica_id FROM sdr.admin_sessions s LEFT JOIN sdr.admin_accounts a ON a.id=s.account_id' +
        ' WHERE s.token_hash=$1 AND s.expires_at>now() AND (s.account_id IS NULL OR a.clinica_id IS NOT NULL)', [hash]
      );
      return rows[0] ?? null;
    },
    async remove(hash) {
      await database.query('DELETE FROM sdr.admin_sessions WHERE token_hash=$1', [hash]);
    }
  };
}

export function adminAuth(config, sessions, accounts) {
  const configured = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.adminEmail ?? '') &&
    config.adminEmail.length <= 254 && /\S/.test(config.adminPassword ?? '') &&
    config.adminPassword.length >= 16 && config.adminPassword.length <= 1024;
  const email = configured ? config.adminEmail.trim().toLowerCase() : fallbackEmail;
  const password = configured ? config.adminPassword : config.adminToken;
  const sign = (purpose, value) => createHmac('sha256', config.adminToken)
    .update(JSON.stringify([purpose, email, password, value])).digest('hex');
  const ownerLimit = loginLimit(8);
  const memberLimit = loginLimit(40);
  let authInFlight = 0;

  function cookie(req) {
    const value = (req.get('Cookie') ?? '').split(';').map(item => item.trim())
      .find(item => item.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    return tokenPattern.test(value ?? '') ? value : null;
  }

  return {
    ownerEmail: email,
    page(req, res) {
      res.type('html').send(loginPage('', req.query.ativo === '1' ? 'Conta ativada. Entre com seu e-mail e sua senha.' : ''));
    },
    async login(req, res) {
      const inputEmail = normalizedEmail(req.body?.email);
      const inputPassword = typeof req.body?.senha === 'string' ? req.body.senha : '';
      const owner = equalSecret(sign('email', inputEmail), sign('email', email));
      const limit = owner ? ownerLimit : memberLimit;
      const retry = limit.retry();
      if (retry || (!owner && authInFlight >= 4)) {
        return res.status(429).set('Retry-After', String(retry || 2))
          .type('html').send(loginPage('Muitas tentativas. Tente novamente em instantes.'));
      }
      let accountId = null;
      if (!owner && accounts) {
        authInFlight++;
        try { accountId = await accounts.authenticate(inputEmail, inputPassword); }
        finally { authInFlight--; }
      }
      if (owner ? !equalSecret(sign('password', inputPassword), sign('password', password)) : !accountId) {
        limit.fail();
        return res.status(401).type('html').send(loginPage('Confira o e-mail e a senha.'));
      }
      const token = randomBytes(32).toString('hex');
      const previous = cookie(req);
      if (previous) await sessions.remove(sign('session', previous));
      await sessions.save(sign('session', token), accountId);
      res.cookie(cookieName, token, { ...cookieOptions, maxAge });
      res.redirect(303, '/admin/treinar');
    },
    async protect(req, res, next) {
      const token = cookie(req);
      const hash = token ? sign('session', token) : null;
      const identity = hash ? await sessions.read(hash) : null;
      if (identity) {
        res.locals.csrf = sign('csrf', token);
        res.locals.session = hash;
        res.locals.memberClinic = identity.clinica_id;
        return next();
      }
      const authorization = req.get('Authorization') ?? '';
      if (!configured && authorization.startsWith('Bearer ') && equalSecret(authorization.slice(7), config.adminToken)) {
        res.locals.csrf = createHmac('sha256', config.adminToken).update('sdr-admin-form-v1').digest('hex');
        return next();
      }
      if (req.path === '/simular') return res.status(401).json({ error: 'Sua sessão expirou. Entre novamente para continuar.' });
      res.redirect(303, '/admin/login');
    },
    async logout(req, res) {
      if (res.locals.session) await sessions.remove(res.locals.session);
      res.clearCookie(cookieName, cookieOptions);
      res.redirect(303, '/admin/login');
    }
  };
}

export function loginLimit(max) {
  let failures = 0;
  let resetAt = 0;
  return {
    retry() {
      const now = Date.now();
      if (now >= resetAt) {
        failures = 0;
        resetAt = now + 60_000;
      }
      return failures >= max ? Math.ceil((resetAt - now) / 1_000) : 0;
    },
    fail() { failures++; }
  };
}
