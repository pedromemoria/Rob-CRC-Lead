# Rob-CRC-Lead

Agente SDR multi-clínica para Kommo e GoHighLevel. O serviço roda em Node.js 24 com Express, OpenAI e Supabase. Cada clínica usa uma conta CRM, seu próprio funil, link de agendamento e treinamento.

## Atualizar o Supabase

- **Banco já instalado** — Abra **SQL Editor → New query**, cole [supabase/multi-clinica.sql](supabase/multi-clinica.sql) e clique em **Run**.
- **Banco novo** — Execute primeiro [supabase/schema.sql](supabase/schema.sql), depois [supabase/multi-clinica.sql](supabase/multi-clinica.sql).

A migração pode ser repetida e preserva os registros anteriores. Eventos, pausas e treinamento do sistema anterior permanecem no banco sem associação automática a uma clínica. Cadastre as clínicas e copie para cada cadastro apenas os textos que pertencem a ela. Os webhooks antigos devem ser atualizados para as novas rotas.

## Render Free

No serviço existente, abra **Environment**. Preencha estas três variáveis e clique em **Save, rebuild, and deploy**. Para um serviço novo, selecione **New → Blueprint**, conecte este repositório, escolha a branch **main** e preencha os mesmos campos. O `render.yaml` configura Node 24, o plano Free e a rota de saúde.

| Variável | Valor |
| --- | --- |
| `DATABASE_URL` | URI do Supabase em **Connect → Session pooler**, porta 5432, com a senha do banco. Copie a URI sem parâmetros SSL. O Node ativa TLS e verifica o certificado. |
| `OPENAI_API_KEY` | Chave da API OpenAI. |
| `ADMIN_TOKEN` | Segredo de 32 a 128 caracteres com letras, números, hífen ou sublinhado. Você pode gerar 64 caracteres hexadecimais com `openssl rand -hex 32`. |

Abra `https://SEU-SERVICO.onrender.com/health` e confirme `{"status":"ok"}`. Em um Web Service configurado manualmente, use runtime Node, plano Free, branch main, `NODE_VERSION=24.x`, build `npm ci --omit=dev`, start `npm start` e Health Check Path `/health`. O serviço usa `PORT` do Render, com fallback para 3000.

O CRM e o link da agenda são configurados no painel. As variáveis fixas antigas dos CRMs e `AGENDAMENTO_URL` podem ser removidas do Render. Se necessário, use `DATABASE_SSL_CA` para fornecer o certificado CA do banco em PEM ou `GHL_WEBHOOK_PUBLIC_KEY` para substituir a chave oficial Ed25519 do GoHighLevel.

### Chave de criptografia dos tokens

Os tokens CRM são criptografados com AES-256-GCM. Por padrão, a chave é derivada de `ADMIN_TOKEN`. Para poder trocar a senha administrativa sem regravar os tokens, defina `CRM_ENCRYPTION_KEY` no Render com 64 caracteres hexadecimais aleatórios **antes de cadastrar as clínicas** e mantenha essa chave estável. Se alterar a chave usada para criptografia, regrave os tokens das clínicas. O segredo do webhook Kommo é armazenado como hash. O painel não mostra os segredos após salvar.

O Render Free pode hibernar após 15 minutos sem tráfego. O primeiro webhook após a hibernação pode ultrapassar o prazo de resposta do CRM. A fila volta a processar os eventos já gravados quando o serviço acorda.

[Conexão PostgreSQL do Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres) · [Limites do Render Free](https://render.com/docs/free)

## Cadastrar clínicas

1. Abra `/admin/treinar` no domínio do serviço. Use **admin** como usuário e o valor de `ADMIN_TOKEN` como senha.
2. Clique em **Nova clínica**. Escolha Kommo ou GoHighLevel, preencha a conta, o token, os IDs de funil, etapa e responsável pelo transbordo, a URL HTTPS de agendamento e os três textos de treinamento.
3. Salve e copie a rota de webhook exibida. Cada conta CRM pode ser vinculada a uma única clínica. A conta e o provedor ficam fixos após criar o cadastro para evitar redirecionamento de eventos pendentes. As demais configurações e os textos podem ser editados.
4. Configure a URL no CRM e valide um evento por clínica. A fila, o histórico e a operação ficam separados por clínica. O login administrativo é central e gerencia todos os cadastros.

### Kommo

- Informe o subdomínio sem `.kommo.com` e o ID numérico da conta. Eles são conferidos no webhook.
- Use um token com acesso a leads, tarefas e **Sending to external chats**. As respostas saem pela API de conversas do complemento Chats API.
- Crie um segredo aleatório para a clínica. Registre **Incoming message received** (`add_message`) em `https://SEU-SERVICO.onrender.com/webhook/kommo/ID_DA_CLINICA?token=SEU_SEGREDO`. Use o segredo correspondente ao cadastro.

[Webhooks Kommo](https://developers.kommo.com/docs/webhooks-general) · [Chats API](https://developers.kommo.com/reference/chats-api-add-on)

### GoHighLevel

- Informe o Location ID e um token da subconta com `conversations/message.write`, `opportunities.readonly`, `opportunities.write` e `contacts.write`.
- No app Marketplace, assine **InboundMessage** e use `https://SEU-SERVICO.onrender.com/webhook/ghl/ID_DA_CLINICA`. O aplicativo confere a assinatura Ed25519 e o Location ID.
- Teste com um contato que tenha uma única oportunidade aberta no funil configurado. O adaptador atende SMS, WhatsApp, Instagram, Facebook, Live Chat e Custom quando o tipo está presente no webhook. Custom exige `conversationProviderId`.

[Assinatura do GoHighLevel](https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/)

## Treinar e publicar respostas

Em `/admin/treinar`, selecione uma clínica e edite **Regras de negócio**, **Quebra de objeções** e **FAQ**. O cadastro começa com modelos de `knowledge/`. Ao salvar, o painel grava os três textos no Supabase para aquela clínica. A próxima classificação lê a revisão atualizada.

Escreva o contexto em texto livre. Para autorizar uma frase que possa sair ao lead, adicione-a a um bloco de respostas, com um identificador único e uma frase por linha. O modelo lê as orientações e escolhe o identificador. O servidor envia a frase publicada, preservando seu conteúdo.

```md
Para dúvidas de valor, use valor_consulta se corresponder à pergunta.

<!-- respostas:sdr -->
valor_consulta | A consulta custa R$ 120,00.
<!-- fim:sdr -->
```

O preço acima é apenas um exemplo de formatação. Publique somente dados comerciais liberados pela equipe. O texto publicado deve ter até 320 caracteres, sem links. Cada campo de treinamento pode ter até 24 KB. O formulário valida e salva a revisão no banco de forma atômica. A nova versão é lida na próxima classificação, inclusive na mesma conversa.

## Operar o agente

- **Resposta.** O GPT-4o escolhe entre `responder`, `qualificar_agendamento` e `transbordo_humano`. O servidor só aceita uma ferramenta por mensagem e produz a saída usando frases fixas ou publicadas. Para pedidos de avaliação conhecidos, há também redirecionamento programático para a sessão.
- **Agendamento.** A decisão requer evidência literal da mensagem atual, validada pelo servidor. Um aceite curto exige oferta de agenda no turno anterior da mesma conversa. Depois da qualificação no CRM, o servidor insere o link da clínica. A confirmação de reserva ocorre na página da agenda.
- **Transbordo.** Ao detectar pedido de humano, irritação, assunto totalmente fora do escopo, descadastro ou evento sem texto, o servidor pausa o lead e cria tarefa atribuída no CRM. A equipe assume a conversa. Para voltar à IA, selecione a clínica em `/admin/operacao`. A reativação limpa o contexto da conversa e descarta mensagens enfileiradas durante a pausa.
- **Falhas.** O webhook retorna sucesso após gravar o evento na fila. A fila deduplica por clínica, provedor, conta e ID da mensagem. Etapas concluídas ficam registradas antes do próximo efeito. Quando a criação de uma mensagem ou tarefa tem resultado incerto, confira o CRM em `/admin/operacao` antes de escolher **Tentar novamente**. Se o CRM já registrou o efeito ou a equipe decidiu assumir, escolha **Encerrar evento**. Um evento pendente impede que eventos seguintes do mesmo lead avancem e permite que outros leads continuem.
- **Dados.** A IA usa até 12 interações recentes por conversa, mantidas por até 30 dias. O corpo dos eventos concluídos é apagado da fila e a chave de deduplicação permanece. Eventos pendentes retêm o conteúdo até resolução. Proteja o banco e seus backups como dados de atendimento. O GPT-4o recebe a base, o texto e o contexto da conversa, com `store: false` na solicitação.
- **Credenciais.** Os tokens dos CRMs são editados no cadastro de cada clínica. Renove-os antes de expirar. Use a chave oficial Ed25519 embutida ou configure `GHL_WEBHOOK_PUBLIC_KEY` com uma chave SPKI DER em Base64 em caso de rotação.

## Verificação

`npm test` exercita os endpoints Express, os formatos de webhook, a assinatura do GHL, autorização e edição do treinamento, isolamento entre clínicas, a seleção de ferramentas, a fila em PostgreSQL e as chamadas dos adaptadores com APIs simuladas. Faça um teste real em cada conta com credenciais e canais configurados antes de liberar tráfego comercial.

```text
.
├── .env.example
├── render.yaml
├── supabase/
│   ├── schema.sql
│   └── multi-clinica.sql
├── knowledge/
│   ├── faq.md
│   ├── quebra_objecoes.md
│   └── regras_negocio.md
├── src/
│   ├── admin.js
│   ├── agent.js
│   ├── clinics.js
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
