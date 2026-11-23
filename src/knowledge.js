import fs from 'fs-extra';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { transaction } from './database.js';

const maxFile = 24_000;
const maxTotal = 96_000;
const fileName = /^[A-Za-z0-9_-]+\.(?:md|txt)$/;
const replyLine = /^([a-z][a-z0-9_]{0,39}) \| (.+)$/u;

export class KnowledgeError extends Error {}

export function safeReply(text) {
  if (typeof text !== 'string') return false;
  const normalized = text.normalize('NFKC');
  // Periods delimit sentences; digit-dot-digit is permitted for prices.
  return normalized === text && text.length <= 320 &&
    /^[\p{Script=Latin}0-9 .,!?'’()\-–%$€£]+$/u.test(text) &&
    !/(?:[^\d\s]\.[^\s]|\d\.[^\d\s]|\.\.)/u.test(text) &&
    !/\b(?:www|https?|mailto|tel)\b/i.test(text) &&
    !/\b\d+(?:\.\d+){2,}\b/u.test(text) &&
    !/\b(?:\d[ -]?){8,}\b/u.test(text);
}

export function parseKnowledge(files) {
  const replies = new Map();
  let total = 0;
  for (const [name, text] of files) {
    const size = Buffer.byteLength(text);
    total += size;
    if (size > maxFile || total > maxTotal) throw new KnowledgeError('Limite da base excedido.');
    let block = false;
    for (const line of text.split(/\r?\n/).map(line => line.trim())) {
      if (line === '<!-- respostas:sdr -->' && !block) {
        block = true;
      } else if (line === '<!-- fim:sdr -->' && block) {
        block = false;
      } else if (line && block) {
        const reply = replyLine.exec(line);
        if (!reply || replies.has(reply[1]) || !safeReply(reply[2])) {
          throw new KnowledgeError('Resposta inválida ou identificador duplicado em ' + name);
        }
        replies.set(reply[1], reply[2]);
      }
    }
    if (block) throw new KnowledgeError('Bloco de respostas sem fechamento em ' + name);
  }
  return { files: Object.fromEntries(files), replies };
}

function readDefaults(dir) {
  const files = new Map();
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && fileName.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  let total = 0;
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    const size = fs.statSync(file).size;
    total += size;
    if (size > maxFile || total > maxTotal) throw new KnowledgeError('Limite da base excedido.');
    files.set(entry.name, fs.readFileSync(file, 'utf8'));
  }
  return files;
}

export function createKnowledge(dir, database) {
  const defaults = readDefaults(dir);

  async function read(client = database) {
    const files = new Map(defaults);
    const { rows } = await client.query('SELECT name,content FROM sdr.knowledge ORDER BY name');
    for (const row of rows) files.set(row.name, row.content);
    return files;
  }

  function revision(content) {
    return createHash('sha256').update(content).digest('hex');
  }

  return {
    load: async () => parseKnowledge(await read()),
    files: read,
    revision,
    async save(name, content, expected) {
      if (typeof name !== 'string' || !fileName.test(name) || typeof content !== 'string') {
        throw new KnowledgeError('Arquivo inválido.');
      }
      await transaction(database, async client => {
        // A base tem limites e identificadores únicos compartilhados por todos os arquivos.
        await client.query('SELECT pg_advisory_xact_lock($1)', [713901483]);
        const files = await read(client);
        if (!files.has(name)) throw new KnowledgeError('Arquivo inválido.');
        if (revision(files.get(name)) !== expected) {
          throw new KnowledgeError('O arquivo mudou. Reabra o editor e tente novamente.');
        }
        files.set(name, content);
        parseKnowledge(files);
        await client.query(
          'INSERT INTO sdr.knowledge(name,content) VALUES($1,$2) ON CONFLICT (name) DO UPDATE SET content = EXCLUDED.content',
          [name, content]
        );
      });
    }
  };
}
