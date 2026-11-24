import axios from 'axios';

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
