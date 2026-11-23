# Rob-CRC-Lead

Backend do agente SDR para Kommo e GoHighLevel.

Backend Node.js 24 com Express, OpenAI GPT-4o, adaptadores dos dois CRMs e painel de treinamento. O objetivo comercial é conduzir o lead à agenda. Ao identificar aceite, o agente qualifica o card ou a oportunidade e envia o link configurado. A reserva e a confirmação do horário acontecem na agenda.

## Rodar

1. Instale o Node.js 24 e execute os comandos na raiz do projeto.

   ```sh
   cp .env.example .env
   npm ci
   openssl rand -hex 32
   openssl rand -hex 32
   ```

2. Preencha o `.env` com as credenciais, os IDs e o link real. Use um dos valores aleatórios para `ADMIN_TOKEN` e o outro para `KOMMO_WEBHOOK_TOKEN`.
3. Execute `npm test` e `npm start`. O serviço abre na porta `3000` por padrão. `/health` verifica se o processo HTTP está disponível.
4. Configure os webhooks com o endereço HTTPS público do serviço. Para administrar o agente, abra `/admin/treinar`. O usuário é `admin` e a senha é `ADMIN_TOKEN`. Clientes HTTP podem enviar `Authorization: Bearer <ADMIN_TOKEN>`.

Em produção, use uma instância do processo por banco SQLite e um volume gravável e persistente para `DATA_DIR` e `KNOWLEDGE_DIR`. Configure HTTPS no proxy reverso e limite o acesso administrativo às pessoas autorizadas a publicar respostas. Retire o token do Kommo dos registros de acesso do proxy e do monitoramento. Renove os tokens fora do processo e reinicie após atualizar o ambiente.

## Configurar Kommo

1. Em uma integração da conta, obtenha um token com leitura e edição de leads, criação de tarefas e o escopo **Sending to external chats**. O envio usa o complemento Chats API do Kommo e depende do plano e dos limites da conta.
2. Configure `KOMMO_SUBDOMAIN` apenas com o trecho anterior a `.kommo.com`, `KOMMO_ACCOUNT_ID` com o ID numérico da conta e `KOMMO_ACCESS_TOKEN` com o Bearer concedido. Preencha os IDs do funil, da etapa **Agendamento / Qualificado** e do usuário que receberá as tarefas.
3. Registre o webhook de conta **Incoming message received** (`add_message`) em `https://SEU_HOST/webhooks/kommo/SEU_KOMMO_WEBHOOK_TOKEN`. A rota valida o segredo e os dados da conta antes de enfileirar o formulário. O Kommo envia esse evento como `application/x-www-form-urlencoded`.
4. Emita uma mensagem de teste de um contato vinculado a um lead. A resposta sai pela conversa `talk_id`, via `POST /api/v4/talks/{talk_id}/send_message`. A qualificação atualiza o lead vinculado no funil configurado. No transbordo, o CRM recebe uma tarefa vinculada ao lead e atribuída ao responsável.

[Webhooks de conta](https://developers.kommo.com/docs/webhooks-general) · [Eventos](https://developers.kommo.com/reference/webhook-events) · [Chats API add-on](https://developers.kommo.com/reference/chats-api-add-on) · [Envio para conversa](https://developers.kommo.com/reference/send-message-to-conversation) · [Tarefas](https://developers.kommo.com/reference/add-tasks)

## Configurar GoHighLevel

1. No aplicativo do Marketplace, configure `https://SEU_HOST/webhooks/ghl`, assine **InboundMessage** e instale o app na subconta. A rota verifica o `X-GHL-Signature` com Ed25519 sobre o corpo bruto e restringe os eventos ao `GHL_LOCATION_ID`.
2. Configure `GHL_ACCESS_TOKEN` com um token da subconta autorizado para `conversations/message.write`, `opportunities.readonly`, `opportunities.write` e `contacts.write`. O token da API pode ser OAuth ou de integração privada autorizado para essas rotas. A assinatura do webhook vem do app do Marketplace.
3. Preencha `GHL_LOCATION_ID`, `GHL_PIPELINE_ID`, `GHL_STAGE_QUALIFICADO_ID` e `GHL_RESPONSAVEL_ID`. Teste com um contato que tenha uma única oportunidade aberta no funil selecionado. Se houver zero ou várias, o agente pausa a IA e cria uma tarefa para a equipe conferir o funil.
4. O adaptador responde nos canais de texto SMS, WhatsApp, Instagram, Facebook, Live Chat e Custom quando o webhook fornece esses tipos e o canal habilitado aceita o envio. Custom exige `conversationProviderId`. Chamadas, correio de voz, e-mail e GMB ficam fora. Mensagens sem texto nos canais atendidos são encaminhadas à equipe.

[Assinatura e configuração](https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/) · [InboundMessage](https://marketplace.gohighlevel.com/docs/webhook/InboundMessage/) · [Envio](https://marketplace.gohighlevel.com/docs/ghl/conversations/send-a-new-message/) · [Busca de oportunidades](https://marketplace.gohighlevel.com/docs/ghl/opportunities/search-opportunity/) · [Tarefas](https://marketplace.gohighlevel.com/docs/ghl/contacts/create-task/)

## Treinar e publicar respostas

O painel `/admin/treinar` lista os arquivos `.md` e `.txt` em `knowledge/`. Os três arquivos iniciais são `regras_negocio.md`, `quebra_objecoes.md` e `faq.md`. Para adicionar um arquivo, coloque-o nessa pasta e abra o painel. Use nomes com letras ASCII, dígitos, hífen ou sublinhado.

Escreva o contexto em texto livre. Para autorizar uma frase que possa sair ao lead, adicione-a a um bloco de respostas, com um identificador único e uma frase por linha. O modelo lê as orientações e escolhe o identificador. O servidor envia a frase publicada, preservando seu conteúdo.

```md
Para dúvidas de valor, use valor_consulta se corresponder à pergunta.

<!-- respostas:sdr -->
valor_consulta | A consulta custa R$ 120,00.
<!-- fim:sdr -->
```

O preço acima é apenas um exemplo de formatação. Publique somente dados comerciais liberados pela equipe. O texto publicado deve ter até 320 caracteres, sem links. Cada arquivo pode ter até 24 KB e a base total até 96 KB. O formulário valida e troca o arquivo de forma atômica. A nova versão é lida na próxima classificação, inclusive na mesma conversa.

## Operar o agente

- **Resposta.** O GPT-4o escolhe entre `responder`, `qualificar_agendamento` e `transbordo_humano`. O servidor só aceita uma ferramenta por mensagem e produz a saída usando frases fixas ou publicadas. Para pedidos de avaliação conhecidos, há também redirecionamento programático para a sessão.
- **Agendamento.** A decisão requer evidência literal da mensagem atual, validada pelo servidor. Um aceite curto exige oferta de agenda no turno anterior da mesma conversa. O link `AGENDAMENTO_URL` é inserido pelo servidor após qualificação no CRM. Se a agenda oferecer confirmação de reserva, ela ocorre na página vinculada.
- **Transbordo.** Ao detectar pedido de humano, irritação, assunto totalmente fora do escopo, descadastro ou evento sem texto, o servidor pausa o lead e cria tarefa atribuída no CRM. A equipe assume a conversa. Para voltar à IA, use `/admin/operacao`. A reativação limpa o contexto local e descarta mensagens enfileiradas durante a pausa.
- **Falhas.** O webhook retorna sucesso após gravar o evento na fila. A fila deduplica por provedor, conta e ID da mensagem. Etapas concluídas ficam registradas antes do próximo efeito. Quando a criação de uma mensagem ou tarefa tem resultado incerto, confira o CRM em `/admin/operacao` antes de escolher **Tentar novamente**. Se o CRM já registrou o efeito ou a equipe decidiu assumir, escolha **Encerrar evento**. Um evento pendente impede que eventos seguintes do mesmo lead avancem e permite que outros leads continuem.
- **Dados.** A IA usa até 12 interações recentes por conversa, mantidas por até 30 dias. O corpo dos eventos concluídos é apagado da fila e a chave de deduplicação permanece. Eventos pendentes retêm o conteúdo até resolução. Proteja o volume e seus backups como dados de atendimento. O GPT-4o recebe a base, o texto e o contexto local, com `store: false` na solicitação.
- **Credenciais.** Os tokens dos CRMs são fornecidos pelo ambiente. Renove-os antes de expirar. Use a chave oficial Ed25519 embutida ou configure `GHL_WEBHOOK_PUBLIC_KEY` com uma chave SPKI DER em Base64 em caso de rotação.

## Verificação

`npm test` exercita os endpoints Express, os formatos de webhook, a assinatura do GHL, autorização e edição do treinamento, a seleção de ferramentas, a fila SQLite e as chamadas dos adaptadores com APIs simuladas. Faça um teste real em cada conta com credenciais e canais configurados antes de liberar tráfego comercial.

```text
.
├── .env.example
├── knowledge/
│   ├── faq.md
│   ├── quebra_objecoes.md
│   └── regras_negocio.md
├── src/
│   ├── admin.js
│   ├── agent.js
│   ├── config.js
│   ├── crm.js
│   ├── knowledge.js
│   ├── server.js
│   ├── store.js
│   ├── webhooks.js
│   └── worker.js
├── test/sdr.test.js
├── package.json
└── package-lock.json
```
