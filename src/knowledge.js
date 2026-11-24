const maxFile = 24_000;
const maxTotal = 96_000;
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
