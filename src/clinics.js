import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { KnowledgeError, parseKnowledge } from './knowledge.js';

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const trainingFields = ['regras_negocio', 'quebra_objecoes', 'faq'];
const numeric = /^[1-9]\d{0,14}$/;
const externalId = /^[A-Za-z0-9_-]{1,128}$/;
const webhookSecret = /^[A-Za-z0-9_-]{32,128}$/;
const columns = 'id,nome_clinica,crm_tipo,crm_account_id,kommo_conta_id,funil_id,etapa_agendamento_id,' +
  'responsavel_id,agendamento_url,regras_negocio,quebra_objecoes,faq,versao,ativo,dados_publicos';

export class ClinicError extends Error {}

const namePattern = /^[^\u0000-\u001f\u007f]{1,120}$/u;

function clinicName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!namePattern.test(name)) throw new ClinicError('Informe o nome da clínica com até 120 caracteres.');
  return name;
}

function bookingUrl(value, required = true) {
  const booking = typeof value === 'string' ? value.trim() : '';
  if (!required && !booking) return null;
  const url = URL.parse(booking);
  if (booking.length > 2048 || url?.protocol !== 'https:' || url.username || url.password || /[\s\\]/u.test(booking)) {
    throw new ClinicError('Informe uma URL de agendamento HTTPS sem credenciais.');
  }
  return booking;
}

function checkVersion(version, current) {
  if (typeof version !== 'string' || !/^[1-9][0-9]{0,9}$/.test(version) || Number(version) !== current.versao) {
    throw new ClinicError('A clínica mudou. Reabra a página e tente novamente.');
  }
}

function parseTraining(form) {
  const content = Object.fromEntries(trainingFields.map(name => {
    if (typeof form[name] !== 'string' || form[name].includes('\0')) {
      throw new ClinicError('Confira o texto de treinamento ' + name + '.');
    }
    return [name, form[name].replace(/\r\n/g, '\n')];
  }));
  try {
    clinicKnowledge(content);
  } catch (error) {
    if (error instanceof KnowledgeError) throw new ClinicError(error.message);
    throw error;
  }
  return content;
}

export function hashWebhook(secret) {
  return createHash('sha256').update(secret).digest('hex');
}

export function clinicKnowledge(clinic) {
  return {
    ...parseKnowledge(trainingFields.map(name => [name + '.md', clinic[name]])),
    clinicData: clinic.dados_publicos ?? {}
  };
}

function parseSettings(form, current) {
  function value(name, pattern, label) {
    const input = typeof form[name] === 'string' ? form[name].trim() : '';
    if (pattern && !pattern.test(input)) throw new ClinicError('Confira o campo ' + label + '.');
    return input;
  }

  const type = current?.crm_tipo ?? value('crm_tipo', /^(kommo|ghl)$/, 'CRM');
  const isKommo = type === 'kommo';
  const connected = Boolean(current?.crm_tipo);
  const idPattern = isKommo ? numeric : externalId;
  const account = current?.crm_account_id ?? value('crm_account_id',
    isKommo ? /^[a-z0-9][a-z0-9-]{0,62}$/ : externalId, 'Conta CRM');
  const kommoAccount = isKommo
    ? current?.kommo_conta_id ?? value('kommo_conta_id', numeric, 'ID numérico da conta Kommo')
    : null;
  const secret = isKommo ? value('webhook_token') : '';
  if (isKommo && (!connected || secret) && !webhookSecret.test(secret)) {
    throw new ClinicError('Use um segredo de webhook Kommo com 32 a 128 caracteres, usando letras, números, hífen ou sublinhado.');
  }

  const token = value('crm_token');
  if ((!connected || token) && !/^[\x21-\x7e]{1,8192}$/.test(token)) {
    throw new ClinicError('Informe um token CRM válido.');
  }
  const stage = value('etapa_agendamento_id', idPattern, 'Etapa de agendamento');
  if (isKommo && ['142', '143'].includes(stage)) throw new ClinicError('Informe uma etapa aberta no Kommo.');
  const active = form.ativo ?? (connected ? current.ativo : true);
  if (![true, false, 'sim', 'nao'].includes(active)) throw new ClinicError('Confira o status do atendimento.');

  const clinic = {
    id: current?.id ?? randomUUID(),
    nome_clinica: clinicName(form.nome_clinica),
    crm_tipo: type, crm_account_id: account, kommo_conta_id: kommoAccount,
    funil_id: value('funil_id', idPattern, 'Funil'), etapa_agendamento_id: stage,
    responsavel_id: value('responsavel_id', idPattern, 'Responsável'), agendamento_url: bookingUrl(form.agendamento_url),
    ativo: active === true || active === 'sim'
  };
  Object.assign(clinic, parseTraining(form));
  return { clinic, token, webhookSecret: secret, webhookHash: secret ? hashWebhook(secret) : null };
}

export function createClinics(database, config, templateDir) {
  const key = config.crmEncryptionKey
    ? Buffer.from(config.crmEncryptionKey, 'hex')
    : Buffer.from(hkdfSync('sha256', config.adminToken, 'rob-crc-lead', 'crm-token-v1', 32));
  const templates = Object.fromEntries(trainingFields.map(name => [
    name, fs.readFileSync(path.join(templateDir, name + '.md'), 'utf8')
  ]));
  clinicKnowledge(templates);

  function encrypt(token, id) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join('.');
  }

  function decrypt(value, id) {
    try {
      const [version, iv, tag, encrypted] = value.split('.');
      if (version !== 'v1') throw new Error('Formato inválido');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'))
        .setAAD(Buffer.from(id)).setAuthTag(Buffer.from(tag, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]).toString('utf8');
    } catch {
      throw new ClinicError('Não foi possível ler o token CRM desta clínica.');
    }
  }

  async function get(id, projection) {
    if (typeof id !== 'string' || !uuid.test(id)) return null;
    const { rows } = await database.query('SELECT ' + projection + ' FROM sdr.clinicas WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  return {
    templates,
    async createDraft(name) {
      const { rows } = await database.query(
        'INSERT INTO sdr.clinicas(nome_clinica,regras_negocio,quebra_objecoes,faq,ativo)' +
        ' VALUES($1,$2,$3,$4,false) RETURNING id',
        [clinicName(name), ...trainingFields.map(field => templates[field])]
      );
      return rows[0].id;
    },
    async saveDraftSettings(form, current) {
      checkVersion(form.versao, current);
      const result = await database.query(
        'UPDATE sdr.clinicas SET nome_clinica=$1,agendamento_url=$2,versao=versao+1 WHERE id=$3 AND versao=$4 AND crm_tipo IS NULL',
        [clinicName(form.nome_clinica), bookingUrl(form.agendamento_url, false), current.id, current.versao]
      );
      if (result.rowCount !== 1) throw new ClinicError('A clínica mudou. Reabra a página e tente novamente.');
    },
    async saveTraining(form, current) {
      checkVersion(form.versao, current);
      const content = parseTraining(form);
      const result = await database.query(
        'UPDATE sdr.clinicas SET regras_negocio=$1,quebra_objecoes=$2,faq=$3,versao=versao+1 WHERE id=$4 AND versao=$5',
        [...trainingFields.map(field => content[field]), current.id, current.versao]
      );
      if (result.rowCount !== 1) throw new ClinicError('A clínica mudou. Reabra a página e tente novamente.');
    },
    async list() {
      const { rows } = await database.query('SELECT id,nome_clinica,crm_tipo,ativo FROM sdr.clinicas ORDER BY nome_clinica,id');
      return rows;
    },
    get: id => get(id, columns),
    async webhookPath(clinic) {
      if (!clinic.crm_tipo) return null;
      const base = '/webhook/' + clinic.crm_tipo + '/' + clinic.id;
      if (clinic.crm_tipo === 'ghl') return base;
      const row = await get(clinic.id, 'webhook_token_cifrado');
      if (!row?.webhook_token_cifrado) return null;
      try {
        const secret = decrypt(row.webhook_token_cifrado, clinic.id + ':webhook');
        return base + '?token=' + encodeURIComponent(secret);
      } catch (error) {
        if (error instanceof ClinicError) return null;
        throw error;
      }
    },
    routing: id => get(id, 'id,crm_tipo,crm_account_id,kommo_conta_id,webhook_token_hash,ativo'),
    async integration(id) {
      const row = await get(id, columns + ',crm_token');
      if (!row?.crm_tipo) throw new ClinicError('A clínica não tem CRM configurado.');
      const raw = decrypt(row.crm_token, id);
      const common = { token: raw, pipelineId: row.funil_id, stageId: row.etapa_agendamento_id, assignee: row.responsavel_id };
      const crm = row.crm_tipo === 'kommo'
        ? { kommo: { subdomain: row.crm_account_id, token: raw, pipelineId: Number(row.funil_id),
          stageId: Number(row.etapa_agendamento_id), assignee: Number(row.responsavel_id) } }
        : { ghl: { ...common, locationId: row.crm_account_id, version: config.ghl.version } };
      return { ...crm, provider: row.crm_tipo, bookingUrl: row.agendamento_url, knowledge: clinicKnowledge(row) };
    },
    async saveData(clinicId, version, data) {
      if (typeof version !== 'string' || !/^[1-9][0-9]{0,9}$/.test(version) || Number(version) > 2_147_483_646) return false;
      const result = await database.query(
        'UPDATE sdr.clinicas SET dados_publicos=$3,versao=versao+1 WHERE id=$1 AND versao=$2',
        [clinicId, Number(version), JSON.stringify(data)]
      );
      return result.rowCount === 1;
    },
    async save(form, current = null) {
      const { clinic, token, webhookHash, webhookSecret } = parseSettings(form, current);
      const encrypted = token ? encrypt(token, clinic.id) : null;
      const encryptedWebhook = webhookSecret ? encrypt(webhookSecret, clinic.id + ':webhook') : null;
      const editable = [clinic.nome_clinica, clinic.funil_id, clinic.etapa_agendamento_id,
        clinic.responsavel_id, clinic.agendamento_url, ...trainingFields.map(name => clinic[name])];
      try {
        if (current) {
          checkVersion(form.versao, current);
          const result = await database.query(
            'UPDATE sdr.clinicas SET nome_clinica=$1,funil_id=$2,etapa_agendamento_id=$3,responsavel_id=$4,' +
            'agendamento_url=$5,regras_negocio=$6,quebra_objecoes=$7,faq=$8,' +
            'crm_token=COALESCE($9,crm_token),webhook_token_hash=COALESCE($10,webhook_token_hash),versao=versao+1 ' +
            ', webhook_token_cifrado=COALESCE($13,webhook_token_cifrado),ativo=$14,crm_tipo=$15,crm_account_id=$16,' +
            'kommo_conta_id=$17 WHERE id=$11 AND versao=$12',
            [...editable, encrypted, webhookHash, clinic.id, current.versao, encryptedWebhook, clinic.ativo,
              clinic.crm_tipo, clinic.crm_account_id, clinic.kommo_conta_id]
          );
          if (result.rowCount !== 1) throw new ClinicError('A clínica mudou. Reabra a página e tente novamente.');
        } else {
          await database.query(
            'INSERT INTO sdr.clinicas(nome_clinica,funil_id,etapa_agendamento_id,responsavel_id,' +
            'agendamento_url,regras_negocio,quebra_objecoes,faq,crm_token,webhook_token_hash,id,crm_tipo,crm_account_id,kommo_conta_id,webhook_token_cifrado,ativo)' +
            ' VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
            [...editable, encrypted, webhookHash, clinic.id, clinic.crm_tipo, clinic.crm_account_id, clinic.kommo_conta_id, encryptedWebhook, clinic.ativo]
          );
        }
      } catch (error) {
        if (error.code === '23505') throw new ClinicError('Esta conta CRM já está vinculada a uma clínica.');
        throw error;
      }
      return clinic.id;
    }
  };
}
