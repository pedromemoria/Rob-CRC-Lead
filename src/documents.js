import path from 'node:path';
import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';
import yauzl from 'yauzl';
import { transaction } from './database.js';

export const uploadBytes = 5 * 1024 * 1024;
const extractedBytes = 160_000;
const xmlBytes = 4 * 1024 * 1024;
const maxFiles = 30;
const formats = new Set(['pdf', 'docx', 'txt', 'csv']);

export class DocumentError extends Error {}

function readWordXml(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      zip.once('error', reject);
      zip.once('end', () => reject(new Error('Documento do Word ausente')));
      zip.on('entry', entry => {
        if (entry.fileName !== 'word/document.xml') return zip.readEntry();
        if (entry.uncompressedSize > xmlBytes) {
          zip.close();
          return reject(new DocumentError('O DOCX contém texto demais.'));
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            zip.close();
            return reject(streamError);
          }
          const chunks = [];
          let size = 0;
          stream.on('data', chunk => {
            size += chunk.length;
            if (size > xmlBytes) return stream.destroy(new DocumentError('O DOCX contém texto demais.'));
            chunks.push(chunk);
          });
          stream.once('error', reject);
          stream.once('end', () => resolve(Buffer.concat(chunks)));
          stream.once('close', () => zip.close());
        });
      });
      zip.readEntry();
    });
  });
}

async function wordText(buffer) {
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(await readWordXml(buffer));
  const parser = new SaxesParser({ xmlns: true });
  const output = [];
  const wordNamespaces = new Set([
    'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'http://purl.oclc.org/ooxml/wordprocessingml/main'
  ]);
  let insideText = false;
  parser.on('doctype', () => { throw new Error('DOCTYPE não permitido'); });
  parser.on('opentag', tag => {
    if (!wordNamespaces.has(tag.uri)) return;
    if (tag.local === 't') insideText = true;
    if (tag.local === 'tab') output.push('\t');
    if (tag.local === 'br') output.push('\n');
  });
  parser.on('text', text => { if (insideText) output.push(text); });
  parser.on('closetag', tag => {
    if (!wordNamespaces.has(tag.uri)) return;
    if (tag.local === 't') insideText = false;
    if (tag.local === 'p') output.push('\n');
  });
  parser.write(xml).close();
  return output.join('');
}

async function pdfText(buffer) {
  if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('Cabeçalho PDF ausente');
  const { PDFParse } = await import('pdf-parse');
  const pdf = new PDFParse({ data: Uint8Array.from(buffer), isEvalSupported: false });
  try {
    const info = await pdf.getInfo();
    if (info.total > 100) throw new DocumentError('O PDF deve ter até 100 páginas.');
    return (await pdf.getText()).text;
  } finally {
    await pdf.destroy();
  }
}

export async function extractDocument(file) {
  if (!file?.buffer?.length || file.buffer.length > uploadBytes) {
    throw new DocumentError('Selecione um arquivo de até 5 MB.');
  }
  const name = path.posix.basename(String(file.originalname ?? '').replaceAll('\\', '/'))
    .replace(/[\p{Cc}\p{Cf}]/gu, '').trim().normalize('NFC');
  const format = path.extname(name).slice(1).toLowerCase();
  if (!formats.has(format) || [...name].length > 180) {
    throw new DocumentError('Use PDF, DOCX, TXT ou CSV, com nome de até 180 caracteres.');
  }
  let content;
  try {
    if (format === 'pdf') content = await pdfText(file.buffer);
    else if (format === 'docx') content = await wordText(file.buffer);
    else {
      const utf16 = file.buffer[0] === 0xff && file.buffer[1] === 0xfe ? 'utf-16le'
        : file.buffer[0] === 0xfe && file.buffer[1] === 0xff ? 'utf-16be' : 'utf-8';
      content = new TextDecoder(utf16, { fatal: true }).decode(file.buffer);
      if (content.includes('\0')) throw new Error('Conteúdo binário');
    }
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError('Não consegui ler este arquivo. Confira o formato, a codificação ou a senha do documento.');
  }
  content = content.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (!content) throw new DocumentError('O arquivo está sem texto extraível. Em um PDF escaneado, use OCR antes do envio.');
  if (Buffer.byteLength(content) > extractedBytes) {
    throw new DocumentError('O texto extraído excede 160 KB. Divida o documento e envie as partes.');
  }
  return { name, format, content, digest: createHash('sha256').update(file.buffer).digest('hex') };
}

export function terms(text) {
  return [...new Set(text.toLowerCase().match(/\p{Script=Latin}{3,}/gu) ?? [])].slice(0, 12);
}

export const maxDocumentContextChars = 12_000;

export function modelReferences(references = []) {
  const result = [];
  let remaining = maxDocumentContextChars - 2;
  for (const reference of references) {
    if (typeof reference?.nome !== 'string' || typeof reference?.trecho !== 'string') continue;
    const nome = reference.nome.slice(0, 180);
    const overhead = JSON.stringify({ nome, trecho: '' }).length + 1;
    if (remaining <= overhead) break;
    let trecho = reference.trecho.slice(0, remaining - overhead);
    while (trecho && JSON.stringify({ nome, trecho }).length + 1 > remaining) {
      trecho = trecho.slice(0, Math.floor(trecho.length / 2));
    }
    if (!trecho) continue;
    remaining -= JSON.stringify({ nome, trecho }).length + 1;
    result.push({ nome, trecho });
  }
  return result;
}

export function createDocuments(database) {
  return {
    async list(clinicId) {
      const { rows } = await database.query(
        'SELECT id,nome,formato,enviado_em FROM sdr.clinic_files WHERE clinica_id = $1 ORDER BY enviado_em DESC,id',
        [clinicId]
      );
      return rows;
    },
    async read(clinicId, fileId) {
      const { rows } = await database.query(
        'SELECT id,nome,formato,enviado_em,conteudo FROM sdr.clinic_files WHERE clinica_id = $1 AND id = $2',
        [clinicId, fileId]
      );
      return rows[0] ?? null;
    },
    async save(clinicId, document) {
      await transaction(database, async client => {
        await client.query('SELECT id FROM sdr.clinicas WHERE id = $1 FOR UPDATE', [clinicId]);
        const { rows: [limit] } = await client.query(
          'SELECT count(*)::integer AS total FROM sdr.clinic_files WHERE clinica_id = $1', [clinicId]
        );
        if (limit.total >= maxFiles) throw new DocumentError('Limite de 30 arquivos por clínica atingido.');
        const result = await client.query(
          'INSERT INTO sdr.clinic_files(clinica_id,nome,formato,conteudo,sha256) VALUES($1,$2,$3,$4,$5) ' +
          'ON CONFLICT (clinica_id,sha256) DO NOTHING',
          [clinicId, document.name, document.format, document.content, document.digest]
        );
        if (!result.rowCount) throw new DocumentError('Este arquivo já está nesta clínica.');
      });
    },
    async remove(clinicId, fileId) {
      const result = await database.query('DELETE FROM sdr.clinic_files WHERE clinica_id = $1 AND id = $2', [clinicId, fileId]);
      return result.rowCount > 0;
    },
    async context(clinicId, query) {
      const search = terms(query).map(word => word.slice(0, 60)).join(' | ');
      if (!search) return [];
      const { rows } = await database.query(
        "WITH search AS (SELECT to_tsquery('portuguese', $2) AS q) " +
        "SELECT nome, left(ts_headline('portuguese', conteudo, q, " +
        "'MaxFragments=3, MinWords=12, MaxWords=65, StartSel=[, StopSel=]'), 2600) AS trecho " +
        'FROM sdr.clinic_files, search WHERE clinica_id = $1 AND busca @@ q ' +
        'ORDER BY ts_rank(busca, q) DESC, enviado_em DESC, id LIMIT 4',
        [clinicId, search]
      );
      return modelReferences(rows);
    }
  };
}
