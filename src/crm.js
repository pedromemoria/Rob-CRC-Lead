import axios from 'axios';
import { SlotUnavailable } from './booking.js';

export class OpportunityError extends Error {}

export function createCrms(config, makeClient = options => axios.create(options)) {
  function client(baseURL, bearer, extraHeaders = {}) {
    return makeClient({
      baseURL, timeout: 12000, maxRedirects: 0,
      headers: {
        Authorization: 'Bearer ' + bearer, Accept: 'application/json', ...extraHeaders
      }
    });
  }

  const k = config.kommo;
  const g = config.ghl;
  const kommo = k && client('https://' + k.subdomain + '.kommo.com/api/v4', k.token);
  const ghl = g && client('https://services.leadconnectorhq.com', g.token, { Version: g.version });

  return {
    kommo: k && {
      async qualify(event) {
        const url = '/leads/' + event.leadId;
        const { data: lead } = await kommo.get(url);
        if (Number(lead?.id) !== Number(event.leadId) || Number(lead.pipeline_id) !== k.pipelineId ||
            [142, 143].includes(Number(lead.status_id))) throw new OpportunityError();
        if (Number(lead.status_id) !== k.stageId) {
          await kommo.patch(url, { pipeline_id: k.pipelineId, status_id: k.stageId });
        }
      },
      async send(event, text) {
        await kommo.post('/talks/' + event.conversationId + '/send_message', { text });
      },
      async handoff(event, text, reference) {
        await kommo.post('/tasks', [{
          entity_id: Number(event.leadId), entity_type: 'leads',
          task_type_id: 1, responsible_user_id: k.assignee,
          complete_till: Math.floor(Date.now() / 1000) + 900,
          text: text + ' Referência ' + reference
        }]);
      }
    },
    ghl: g && {
      async slots(booking, now = Date.now()) {
        const { data } = await ghl.get('/calendars/' + booking.calendarId + '/free-slots', {
          params: { startDate: now, endDate: now + 14 * 86_400_000, timezone: booking.timezone }
        });
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Resposta inválida da agenda');
        return Object.entries(data).filter(([date, value]) => /^\d{4}-\d{2}-\d{2}$/.test(date) &&
          Array.isArray(value?.slots)).flatMap(([, value]) => value.slots.filter(slot => typeof slot === 'string'));
      },
      async book(event, booking, start) {
        const endTime = new Date(Date.parse(start) + booking.duration * 60_000).toISOString();
        try {
          const { data } = await ghl.post('/calendars/events/appointments', {
            calendarId: booking.calendarId, locationId: g.locationId, contactId: event.leadId,
            title: 'Avaliação', startTime: start, endTime, appointmentStatus: 'confirmed',
            ignoreFreeSlotValidation: false, ignoreDateRange: false
          });
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(data?.id ?? '') || data.calendarId !== booking.calendarId ||
              data.locationId !== g.locationId || data.contactId !== event.leadId ||
              Date.parse(data.startTime) !== Date.parse(start) || data.appointmentStatus !== 'confirmed') {
            throw new Error('O CRM ainda não confirmou a reserva');
          }
          return data.id;
        } catch (error) {
          const status = error.response?.status;
          const message = error.response?.data?.message;
          if (status === 409 || (status === 400 && typeof message === 'string' &&
              /(?:slot|time).*(?:unavailable|not available|already booked|no longer)/i.test(message))) {
            throw new SlotUnavailable();
          }
          throw error;
        }
      },
      async qualify(event) {
        const { data } = await ghl.get('/opportunities/search', {
          params: { locationId: g.locationId, pipelineId: g.pipelineId,
            contactId: event.leadId, status: 'open', page: 1, limit: 20 }
        });
        const candidates = data?.opportunities;
        if (!Array.isArray(candidates)) throw new Error('Resposta inesperada do GHL');
        const [opp] = candidates;
        if (candidates.length !== 1 || data?.meta?.nextPage || Number(data?.meta?.total) > 1 ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(opp?.id ?? '') ||
            opp.pipelineId !== g.pipelineId || opp.locationId !== g.locationId ||
            (opp.contactId ?? opp.contact?.id) !== event.leadId || opp.status !== 'open') {
          throw new OpportunityError();
        }
        if (opp.pipelineStageId !== g.stageId) {
          await ghl.put('/opportunities/' + opp.id, { pipelineStageId: g.stageId });
        }
      },
      async send(event, text) {
        await ghl.post('/conversations/messages', {
          type: event.channel, contactId: event.leadId, message: text, status: 'pending',
          ...(event.providerId ? { conversationProviderId: event.providerId } : {})
        });
      },
      async handoff(event, text, reference) {
        await ghl.post('/contacts/' + event.leadId + '/tasks', {
          title: 'SDR · atendimento humano',
          body: text + ' Conversa ' + event.conversationId + '. Referência ' + reference,
          assignedTo: g.assignee, completed: false,
          dueDate: new Date(Date.now() + 900_000).toISOString()
        });
      }
    }
  };
}
