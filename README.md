# Rob-CRC-Lead

Backend do agente SDR para Kommo e GoHighLevel.

Backend Node.js 24 com Express, OpenAI GPT-4o, adaptadores dos dois CRMs e painel de treinamento. O objetivo comercial é conduzir o lead à agenda. Ao identificar aceite, o agente qualifica o card ou a oportunidade e envia o link configurado. A reserva e a confirmação do horário acontecem na agenda.

## Publicar no Render Free com Supabase

### 1. Preparar o banco gratuito

1. No [Supabase](https://supabase.com/dashboard), clique em **New project**. Escolha a organização, dê um nome ao projeto e guarde a senha do banco.
2. No projeto, abra **SQL Editor → New query**. Cole todo o conteúdo de [supabase/schema.sql](supabase/schema.sql) e clique em **Run**. O script pode ser executado novamente sem apagar dados. Ele cria as tabelas em um schema privado, usado pelo servidor via PostgreSQL.
3. Clique em **Connect** e selecione **Session pooler** na porta **5432**. Copie a URI PostgreSQL, substitua o marcador de senha pela senha do banco e codifique caracteres reservados da senha como em qualquer URL, por exemplo, @ vira %40. Essa URI inteira é o valor de `DATABASE_URL`. Copie a URI sem parâmetros SSL. O Node ativa TLS com verificação do certificado. Se a cadeia de certificados não for confiável no runtime, obtenha o certificado CA nas configurações do banco no Supabase e salve o conteúdo PEM completo em `DATABASE_SSL_CA` no Render.

[Conexões do Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres) · [TLS](https://supabase.com/docs/guides/platform/ssl-enforcement)

### 2. Criar o serviço gratuito

1. No [Render Dashboard](https://dashboard.render.com), clique em **New → Blueprint**. Conecte o GitHub, selecione `pedromemoria/Rob-CRC-Lead` e use a branch `main`. O Render lê [render.yaml](render.yaml) na raiz.
2. Escolha um nome para o Blueprint e preencha os campos solicitados conforme a tabela. Clique em **Deploy Blueprint**.
3. Em **Events** ou **Logs**, aguarde o deploy ficar **Live**. Abra `https://SEU-SERVICO.onrender.com/health`. O serviço deve retornar `{"status":"ok"}`.
4. Acesse `/admin/treinar` no mesmo domínio. Entre como admin e use `ADMIN_TOKEN` como senha. Cadastre os webhooks dos CRMs conforme as seções abaixo.

Se já criou o Web Service manualmente, use **Settings** para selecionar GitHub, o repositório e a branch `main`, com runtime **Node**, plano **Free**, **Build Command** `npm ci --omit=dev`, **Start Command** `npm start` e **Health Check Path** `/health`. Adicione as variáveis em **Environment → Add Environment Variable**, inclusive `NODE_VERSION=24.x`, e clique em **Save, rebuild, and deploy**. O serviço usa `PORT` do Render com fallback local de 3000 e escuta em `0.0.0.0`. Os dados persistem no Supabase.

| Variável | Valor |
| --- | --- |
| `DATABASE_URL` | URI do Session pooler do Supabase, com senha e porta 5432. |
| `OPENAI_API_KEY` | Chave da API OpenAI. |
| `ADMIN_TOKEN` | Segredo de 32 ou mais caracteres URL-safe para entrar no painel. |
| `AGENDAMENTO_URL` | URL HTTPS da agenda. |
| `KOMMO_SUBDOMAIN` | Subdomínio Kommo, sem `.kommo.com`. |
| `KOMMO_ACCOUNT_ID` | ID numérico da conta Kommo. |
| `KOMMO_ACCESS_TOKEN` | Token Kommo com os escopos descritos abaixo. |
| `KOMMO_WEBHOOK_TOKEN` | Outro segredo de 32 ou mais caracteres URL-safe. Ele faz parte da URL do webhook Kommo. |
| `KOMMO_PIPELINE_ID` | ID numérico do funil Kommo. |
| `KOMMO_STAGE_QUALIFICADO_ID` | ID numérico da etapa aberta de qualificação. |
| `KOMMO_RESPONSAVEL_ID` | ID numérico do responsável por tarefas. |
| `GHL_ACCESS_TOKEN` | Token da subconta GoHighLevel com os escopos descritos abaixo. |
| `GHL_LOCATION_ID` | ID da subconta. |
| `GHL_PIPELINE_ID` | ID do funil. |
| `GHL_STAGE_QUALIFICADO_ID` | ID da etapa de qualificação. |
| `GHL_RESPONSAVEL_ID` | ID do responsável por tarefas. |

Use dois segredos aleatórios distintos para `ADMIN_TOKEN` e `KOMMO_WEBHOOK_TOKEN`. Um gerenciador de senhas pode gerar cada valor com 64 caracteres hexadecimais. `OPENAI_MODEL` e `GHL_API_VERSION` já usam `gpt-4o` e `v3` por padrão. `GHL_WEBHOOK_PUBLIC_KEY` só é necessária para substituir a chave oficial. Mantenha chaves e URI do banco no painel.

Após 15 minutos sem tráfego de entrada, o Render Free pode hibernar. A próxima requisição pode levar cerca de um minuto para despertar o serviço e ultrapassar o prazo do webhook. O PostgreSQL preserva eventos já registrados e a fila retoma ao despertar. Para testar, abra `/health` e aguarde a resposta antes de enviar a mensagem pelo CRM.

[Blueprints do Render](https://render.com/docs/infrastructure-as-code) · [Plano gratuito](https://render.com/docs/free)

### Executar fora do Render

Com Node.js 24, aplique o mesmo schema em um banco PostgreSQL com TLS, copie `.env.example` para `.env`, preencha os valores e execute `npm ci` seguido de `npm start`. Use `npm test` para a suíte com PostgreSQL embutido, sem credenciais de serviços externos.

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

O painel `/admin/treinar` combina os arquivos iniciais de `knowledge/` com as revisões salvas no PostgreSQL. Uma revisão salva pelo painel tem prioridade sobre o arquivo de mesmo nome no GitHub, inclusive após redeploy. Para adicionar um arquivo `.md` ou `.txt`, inclua-o em `knowledge/` e faça deploy. Use nomes com letras ASCII, dígitos, hífen ou sublinhado.

Escreva o contexto em texto livre. Para autorizar uma frase que possa sair ao lead, adicione-a a um bloco de respostas, com um identificador único e uma frase por linha. O modelo lê as orientações e escolhe o identificador. O servidor envia a frase publicada, preservando seu conteúdo.

```md
Para dúvidas de valor, use valor_consulta se corresponder à pergunta.

<!-- respostas:sdr -->
valor_consulta | A consulta custa R$ 120,00.
<!-- fim:sdr -->
```

O preço acima é apenas um exemplo de formatação. Publique somente dados comerciais liberados pela equipe. O texto publicado deve ter até 320 caracteres, sem links. Cada arquivo pode ter até 24 KB e a base total até 96 KB. O formulário valida e salva a revisão no banco de forma atômica. A nova versão é lida na próxima classificação, inclusive na mesma conversa.

## Operar o agente

- **Resposta.** O GPT-4o escolhe entre `responder`, `qualificar_agendamento` e `transbordo_humano`. O servidor só aceita uma ferramenta por mensagem e produz a saída usando frases fixas ou publicadas. Para pedidos de avaliação conhecidos, há também redirecionamento programático para a sessão.
- **Agendamento.** A decisão requer evidência literal da mensagem atual, validada pelo servidor. Um aceite curto exige oferta de agenda no turno anterior da mesma conversa. O link `AGENDAMENTO_URL` é inserido pelo servidor após qualificação no CRM. Se a agenda oferecer confirmação de reserva, ela ocorre na página vinculada.
- **Transbordo.** Ao detectar pedido de humano, irritação, assunto totalmente fora do escopo, descadastro ou evento sem texto, o servidor pausa o lead e cria tarefa atribuída no CRM. A equipe assume a conversa. Para voltar à IA, use `/admin/operacao`. A reativação limpa o contexto da conversa e descarta mensagens enfileiradas durante a pausa.
- **Falhas.** O webhook retorna sucesso após gravar o evento na fila. A fila deduplica por provedor, conta e ID da mensagem. Etapas concluídas ficam registradas antes do próximo efeito. Quando a criação de uma mensagem ou tarefa tem resultado incerto, confira o CRM em `/admin/operacao` antes de escolher **Tentar novamente**. Se o CRM já registrou o efeito ou a equipe decidiu assumir, escolha **Encerrar evento**. Um evento pendente impede que eventos seguintes do mesmo lead avancem e permite que outros leads continuem.
- **Dados.** A IA usa até 12 interações recentes por conversa, mantidas por até 30 dias. O corpo dos eventos concluídos é apagado da fila e a chave de deduplicação permanece. Eventos pendentes retêm o conteúdo até resolução. Proteja o banco e seus backups como dados de atendimento. O GPT-4o recebe a base, o texto e o contexto da conversa, com `store: false` na solicitação.
- **Credenciais.** Os tokens dos CRMs são fornecidos pelo ambiente. Renove-os antes de expirar. Use a chave oficial Ed25519 embutida ou configure `GHL_WEBHOOK_PUBLIC_KEY` com uma chave SPKI DER em Base64 em caso de rotação.

## Verificação

`npm test` exercita os endpoints Express, os formatos de webhook, a assinatura do GHL, autorização e edição do treinamento, a seleção de ferramentas, a fila em PostgreSQL e as chamadas dos adaptadores com APIs simuladas. Faça um teste real em cada conta com credenciais e canais configurados antes de liberar tráfego comercial.

```text
.
├── .env.example
├── render.yaml
├── supabase/schema.sql
├── knowledge/
│   ├── faq.md
│   ├── quebra_objecoes.md
│   └── regras_negocio.md
├── src/
│   ├── admin.js
│   ├── agent.js
│   ├── config.js
│   ├── crm.js
│   ├── database.js
│   ├── knowledge.js
│   ├── server.js
│   ├── store.js
│   ├── webhooks.js
│   └── worker.js
├── test/sdr.test.js
├── package.json
└── package-lock.json
```
