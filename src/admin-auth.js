import { createHmac, randomBytes } from 'node:crypto';
import { equalSecret } from './webhooks.js';
import { loginPage } from './admin-view.js';

const fallbackEmail = 'admin@robocrc.local';
const cookieName = '__Host-crc_session';
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };
const maxAge = 8 * 60 * 60 * 1_000;
const tokenPattern = /^[a-f0-9]{64}$/;

export function createSessions(database) {
  return {
    async save(hash) {
      await database.query('DELETE FROM sdr.admin_sessions WHERE expires_at <= now()');
      await database.query("INSERT INTO sdr.admin_sessions(token_hash,expires_at) VALUES ($1,now() + interval '8 hours')", [hash]);
    },
    async valid(hash) {
      const result = await database.query('SELECT 1 FROM sdr.admin_sessions WHERE token_hash=$1 AND expires_at>now()', [hash]);
      return result.rowCount === 1;
    },
    async remove(hash) {
      await database.query('DELETE FROM sdr.admin_sessions WHERE token_hash=$1', [hash]);
    }
  };
}

export function adminAuth(config, sessions) {
  const configured = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.adminEmail ?? '') &&
    config.adminEmail.length <= 254 && /\S/.test(config.adminPassword ?? '') &&
    config.adminPassword.length >= 16 && config.adminPassword.length <= 1024;
  const email = configured ? config.adminEmail.trim().toLowerCase() : fallbackEmail;
  const password = configured ? config.adminPassword : config.adminToken;
  const sign = (purpose, value) => createHmac('sha256', config.adminToken)
    .update(JSON.stringify([purpose, email, password, value])).digest('hex');
  let failures = 0;
  let resetAt = 0;

  function cookie(req) {
    const value = (req.get('Cookie') ?? '').split(';').map(item => item.trim())
      .find(item => item.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    return tokenPattern.test(value ?? '') ? value : null;
  }

  return {
    page(req, res) {
      res.type('html').send(loginPage());
    },
    async login(req, res) {
      if (req.get('Sec-Fetch-Site') === 'same-site') return res.sendStatus(403);
      const now = Date.now();
      if (now >= resetAt) {
        failures = 0;
        resetAt = now + 60_000;
      }
      if (failures >= 8) {
        return res.status(429).set('Retry-After', String(Math.ceil((resetAt - now) / 1_000)))
          .type('html').send(loginPage('Muitas tentativas. Tente novamente em instantes.'));
      }
      const inputEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      const inputPassword = typeof req.body?.senha === 'string' ? req.body.senha : '';
      const emailMatches = equalSecret(sign('email', inputEmail), sign('email', email));
      const passwordMatches = equalSecret(sign('password', inputPassword), sign('password', password));
      if (!emailMatches || !passwordMatches) {
        failures++;
        return res.status(401).type('html').send(loginPage('Confira o e-mail e a senha.'));
      }
      failures = 0;
      const token = randomBytes(32).toString('hex');
      const previous = cookie(req);
      if (previous) await sessions.remove(sign('session', previous));
      await sessions.save(sign('session', token));
      res.cookie(cookieName, token, { ...cookieOptions, maxAge });
      res.redirect(303, '/admin/treinar');
    },
    async protect(req, res, next) {
      const token = cookie(req);
      if (token && await sessions.valid(sign('session', token))) {
        res.locals.csrf = sign('csrf', token);
        res.locals.session = sign('session', token);
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
