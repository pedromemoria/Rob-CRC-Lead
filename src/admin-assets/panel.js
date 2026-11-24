'use strict';

const type = document.querySelector('#crm_tipo');
if (type) {
  const update = () => {
    for (const element of document.querySelectorAll('[data-kommo]')) {
      element.hidden = type.value !== 'kommo';
      const field = element.querySelector('input');
      field.disabled = element.hidden;
      field.required = !element.hidden;
    }
  };
  type.addEventListener('change', update);
  update();
}

const webhook = document.querySelector('[data-webhook]');
if (webhook) {
  const url = new URL(webhook.dataset.webhook, location.origin).href;
  webhook.textContent = url;
  document.querySelector('[data-copy]').addEventListener('click', async () => {
    const status = document.querySelector('#copy-status');
    try {
      await navigator.clipboard.writeText(url);
      status.textContent = 'Link copiado.';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(webhook);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = 'Link selecionado. Use a opção de copiar do navegador.';
    }
  });
}

const drop = document.querySelector('[data-drop]');
if (drop) {
  const file = drop.querySelector('input');
  const filename = drop.querySelector('[data-filename]');
  const update = () => { filename.textContent = file.files[0]?.name ?? ''; };
  file.addEventListener('change', update);
  drop.addEventListener('dragover', event => {
    event.preventDefault();
    drop.classList.add('dragging');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', event => {
    event.preventDefault();
    drop.classList.remove('dragging');
    const selected = event.dataTransfer?.files[0];
    if (!selected) return;
    const files = new DataTransfer();
    files.items.add(selected);
    file.files = files.files;
    update();
  });
}

for (const form of document.querySelectorAll('[data-confirm]')) {
  form.addEventListener('submit', event => {
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  });
}

const sim = document.querySelector('[data-simulator]');
if (sim) {
  const log = document.querySelector('[data-chat-log]');
  const status = sim.querySelector('[data-chat-status]');
  const send = sim.querySelector('.composer button');
  const reset = sim.querySelector('[data-reset]');
  const history = [];
  const clinicName = sim.elements.nome_clinica;
  const offline = sim.elements.offline;
  const documents = sim.elements.include_documents;
  let useDocuments = true;
  let previousName;

  function message(kind, text, detail) {
    log.querySelector('[data-empty]')?.remove();
    const bubble = document.createElement('div');
    bubble.className = 'bubble ' + kind;
    const label = document.createElement('strong');
    label.textContent = kind === 'lead' ? 'Lead' : previousName || 'Robô CRC';
    const content = document.createElement('p');
    content.textContent = text;
    bubble.append(label, content);
    if (detail) {
      const info = document.createElement('small');
      info.textContent = detail;
      bubble.append(info);
    }
    log.append(bubble);
    log.scrollTop = log.scrollHeight;
  }

  function clearConversation() {
    history.length = 0;
    log.replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.dataset.empty = '';
    empty.textContent = 'Envie uma mensagem para iniciar o teste.';
    log.append(empty);
    status.textContent = '';
  }
  function refreshDocuments() {
    if (!documents) return;
    documents.disabled = offline.checked || send.disabled;
    documents.checked = !offline.checked && useDocuments;
  }
  offline.addEventListener('change', () => {
    refreshDocuments();
    if (history.length) {
      clearConversation();
      status.textContent = 'Nova conversa iniciada com o modo de simulação selecionado.';
    }
  });
  documents?.addEventListener('change', () => {
    useDocuments = documents.checked;
    if (history.length) {
      clearConversation();
      status.textContent = 'Nova conversa iniciada com a seleção de documentos atual.';
    }
  });
  reset.addEventListener('click', () => {
    clearConversation();
    sim.elements.mensagem.focus();
  });

  sim.addEventListener('submit', async event => {
    event.preventDefault();
    const text = sim.elements.mensagem.value.trim();
    if (!text || send.disabled) return;
    const name = clinicName?.value.trim();
    if (clinicName && !name) {
      status.textContent = 'Informe o nome da clínica.';
      clinicName.focus();
      return;
    }
    if (name !== previousName) clearConversation();
    previousName = name;
    if (clinicName) clinicName.disabled = true;
    send.disabled = true;
    reset.disabled = true;
    const withAI = !offline.checked;
    const includeDocuments = withAI && Boolean(documents?.checked);
    offline.disabled = true;
    refreshDocuments();
    status.textContent = 'Preparando resposta…';
    try {
      const response = await fetch(sim.action, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-CSRF-Token': sim.elements._csrf.value
      }, body: JSON.stringify({ text, withAI, includeDocuments, history: history.slice(-80), nome_clinica: name }) });
      const answer = await response.json();
      if (!response.ok) throw new Error(answer.error || 'Falha no teste.');
      message('lead', text);
      const sources = answer.sources.length ? ' · Documentos enviados à IA: ' + answer.sources.join(', ') : '';
      const notes = answer.feedbackCount
        ? ' · Feedbacks enviados à IA (' + answer.feedbackCount + ')'
        : '';
      message('robot', answer.reply, answer.action + sources + notes);
      history.push({ inbound: text, outbound: answer.reply, offered: answer.offered, agenda_ofertada: answer.agenda_ofertada });
      if (history.length > 80) history.shift();
      sim.elements.mensagem.value = '';
      status.textContent = '';
    } catch (error) {
      status.textContent = error instanceof SyntaxError ? 'Falha no teste. Tente novamente.' : error.message;
    } finally {
      if (clinicName) clinicName.disabled = false;
      send.disabled = false;
      reset.disabled = false;
      offline.disabled = false;
      refreshDocuments();
      sim.elements.mensagem.focus();
    }
  });
}

const clinicSearch = document.querySelector('#clinica-busca');
if (clinicSearch) {
  const clinics = [...document.querySelectorAll('[data-clinic]')];
  const noMatch = document.querySelector('[data-no-match]');
  const normalize = text => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLocaleLowerCase('pt-BR');
  clinicSearch.addEventListener('input', () => {
    const query = normalize(clinicSearch.value);
    for (const clinic of clinics) clinic.hidden = !normalize(clinic.querySelector('.clinic-name').textContent).includes(query);
    noMatch.hidden = !query || clinics.some(clinic => !clinic.hidden);
  });
}

const activation = document.querySelector('[data-activation]');
if (activation) {
  if (location.hash) {
    activation.elements.convite.value = location.hash.slice(1);
    history.replaceState(null, '', location.pathname);
  }
}

const invitation = document.querySelector('#activation-link');
if (invitation) {
  invitation.value = new URL(invitation.value, location.origin).href;
  document.querySelector('[data-copy-invitation]').addEventListener('click', async () => {
    const status = document.querySelector('[data-invitation-status]');
    try {
      await navigator.clipboard.writeText(invitation.value);
      status.textContent = 'Link copiado.';
    } catch {
      invitation.select();
      status.textContent = 'Link selecionado. Copie pelo navegador.';
    }
  });
}

for (const group of document.querySelectorAll('[data-data-group]')) {
  const rows = group.querySelector('[data-data-rows]');
  const template = group.querySelector('template');
  const add = group.querySelector('[data-add-data]');
  const status = group.querySelector('[data-data-status]');
  const max = Number(group.dataset.maxRows);
  function refresh() {
    add.disabled = rows.children.length >= max;
    status.textContent = add.disabled ? 'Limite de ' + max + ' registros.' : '';
  }
  add.addEventListener('click', () => {
    if (rows.children.length >= max) return;
    rows.append(template.content.cloneNode(true));
    refresh();
    rows.lastElementChild.querySelector('input').focus();
  });
  rows.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-data]');
    if (!button) return;
    const row = button.closest('[data-data-row]');
    const next = row.nextElementSibling ?? row.previousElementSibling;
    row.remove();
    refresh();
    (next?.querySelector('input') ?? add).focus();
  });
  refresh();
}
