import { createHmac } from 'node:crypto';
import { normalize } from './sales.js';

const defaultTimezone = 'America/Fortaleza';
export const bookingFields = [
  ['calendarId', 'ID do calendário GoHighLevel', 'text'],
  ['timezone', 'Fuso da agenda (ex.: America/Fortaleza)', 'text'],
  ['duration', 'Duração da consulta em minutos', 'number'],
  ['bookingLink', 'Link público de reservas', 'url']
];

export class SlotUnavailable extends Error {}

export function parseBooking(form, provider) {
  if (!bookingFields.some(([key]) => Object.hasOwn(form, key))) return null;
  const text = key => typeof form[key] === 'string' ? form[key].trim() : '';
  const calendarId = provider === 'ghl' ? text('calendarId') : '';
  const bookingLink = text('bookingLink');
  if (calendarId && !/^[A-Za-z0-9_-]{1,128}$/.test(calendarId)) throw new Error('Confira o ID do calendário.');
  const timezone = text('timezone') || defaultTimezone;
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: timezone }); }
  catch { throw new Error('Informe um fuso IANA válido, como America/Fortaleza.'); }
  const duration = Number(text('duration') || '30');
  if (!Number.isInteger(duration) || duration < 5 || duration > 240) throw new Error('Informe uma duração entre 5 e 240 minutos.');
  const parsed = bookingLink && URL.parse(bookingLink);
  if (bookingLink && (parsed?.protocol !== 'https:' || parsed.username || parsed.password ||
      bookingLink.length > 2048 || /[\s\\\u0000-\u001f]/u.test(bookingLink))) throw new Error('Informe um link público HTTPS válido.');
  return { calendarId, timezone, duration, bookingLink };
}

export function availableOptions(slots, booking, turn, now = Date.now()) {
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: booking.timezone || defaultTimezone, weekday: 'long', day: '2-digit',
    month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const options = [...new Set(slots.map(slot => Date.parse(slot)).filter(time => Number.isFinite(time) && time > now))]
    .sort((a, b) => a - b).map(time => {
      const parts = Object.fromEntries(formatter.formatToParts(time).map(part => [part.type, part.value]));
      return { start: new Date(time).toISOString(), day: parts.day + '/' + parts.month,
        text: parts.weekday + ', ' + parts.day + '/' + parts.month + ', às ' + parts.hour + 'h' + parts.minute,
        turn: Number(parts.hour) < 12 ? 'manhã' : 'tarde' };
    });
  const preferred = options.filter(option => option.turn === turn);
  const ranked = [...preferred, ...options.filter(option => option.turn !== turn)];
  if (!ranked.length) return [];
  const second = ranked.slice(1).find(option => option.day !== ranked[0].day &&
    (preferred.length < 2 || option.turn === turn)) ?? ranked[1];
  return [ranked[0], second].filter(Boolean);
}

export function chosenOption(message, options) {
  const text = normalize(message);
  if (/\b(?:nao|talvez|ou|depois)\b/.test(text)) return -1;
  const match = /^(?:(?:prefiro|quero|pode ser|escolho) )?(?:a )?(?:opcao )?(1|2|primeira|segunda)(?: opcao)?[.! ]*$/u.exec(text);
  if (match) return ['1', 'primeira'].includes(match[1]) ? 0 : options.length > 1 ? 1 : -1;
  const exact = options.findIndex(option => text === normalize(option.text));
  if (exact >= 0) return exact;
  const weekday = /\b(?:segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/.exec(text)?.[0];
  const date = /\b(\d{1,2})\/(\d{1,2})\b/.exec(text);
  const hour = /\b(\d{1,2})(?:h(?:(\d{2}))?|:(\d{2}))\b/.exec(text);
  if (!weekday && !date && !hour) return -1;
  const padded = value => String(value).padStart(2, '0');
  const matches = options.map((option, index) => ({ index, text: normalize(option.text) })).filter(option =>
    (!weekday || option.text.startsWith(weekday)) &&
    (!date || option.text.includes(padded(date[1]) + '/' + padded(date[2]))) &&
    (!hour || option.text.includes(padded(hour[1]) + 'h' + (hour[2] ?? hour[3] ?? '00'))));
  return matches.length === 1 ? matches[0].index : -1;
}

export function slotMessage(options) {
  return 'Encontrei estas opções na agenda:\n' +
    options.map((option, index) => (index + 1) + '. ' + option.text).join('\n') +
    '\nQual opção você prefere?';
}

export function bookingCallbackToken(adminToken, clinicId) {
  return createHmac('sha256', adminToken).update('agenda-confirmada:' + clinicId).digest('hex');
}

export function externalBookingLink(link, ref) {
  const url = new URL(link);
  url.searchParams.set('crc_ref', ref);
  return url.href;
}
