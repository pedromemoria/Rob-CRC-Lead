# Rob-CRC-Lead

Agente SDR multi-clínica para Kommo e GoHighLevel. O serviço roda em Node.js 24 com Express, Gemini, OpenAI e Supabase. Cada clínica usa uma conta CRM, seu próprio funil, equipe responsável e treinamento.

## Atualizar o Supabase

Aplique [supabase/agenda-autonoma.sql](supabase/agenda-autonoma.sql) após as demais migrações para persistir a configuração da agenda e as vagas oferecidas.

Aplique [supabase/agendamento-erp.sql](supabase/agendamento-erp.sql) após as migrações abaixo para conectar o CRM sem precisar de um link de agendamento.

Aplique [supabase/cadastro-rapido.sql](supabase/cadastro-rapido.sql) depois das migrações abaixo para criar clínicas só com o nome.

Aplique [supabase/dados-clinicas.sql](supabase/dados-clinicas.sql) após as migrações anteriores para habilitar os dados e preços por clínica.

Aplique [supabase/contas-admin.sql](supabase/contas-admin.sql) depois das migrações abaixo para habilitar o cadastro individual.

- **Banco multi-clínica já instalado** — Execute [supabase/painel-clinicas.sql](supabase/painel-clinicas.sql) e [supabase/admin-saas.sql](supabase/admin-saas.sql) em **SQL Editor → New query → Run**.
- **Painel com biblioteca já instalado** — Execute [supabase/admin-saas.sql](supabase/admin-saas.sql) antes do deploy. O script adiciona sessões, feedbacks e status de atendimento.
- **Banco novo** — Execute primeiro [supabase/schema.sql](supabase/schema.sql), depois [supabase/multi-clinica.sql](supabase/multi-clinica.sql), [supabase/painel-clinicas.sql](supabase/painel-clinicas.sql) e [supabase/admin-saas.sql](supabase/admin-saas.sql).

Aplique cada migração uma vez, na ordem indicada. As migrações preservam os registros anteriores. Eventos, pausas e treinamento do sistema anterior permanecem no banco sem associação automática a uma clínica. Cadastre as clínicas e copie para cada cadastro apenas os textos que pertencem a ela. Os webhooks antigos devem ser atualizados para as novas rotas.

## Render Free

No serviço existente, abra **Environment**. Preencha estas três variáveis e clique em **Save, rebuild, and deploy**. Para um serviço novo, selecione **New → Blueprint**, conecte este repositório, escolha a branch **main** e preencha os mesmos campos. O `render.yaml` configura Node 24, o plano Free e a rota de saúde.

| Variável | Valor |
| --- | --- |
| `DATABASE_URL` | URI do Supabase em **Connect → Session pooler**, porta 5432, com a senha do banco. Copie a URI sem parâmetros SSL. O Node ativa TLS e verifica o certificado. |
| `GEMINI_API_KEY` | Chave do Google AI Studio. O robô usa `gemini-2.5-flash` como primeira opção. |
| `OPENAI_API_KEY` | Contingência opcional. O serviço precisa de pelo menos uma das duas chaves. |
| `ADMIN_TOKEN` | Segredo de 32 a 128 caracteres com letras, números, hífen ou sublinhado. Você pode gerar 64 caracteres hexadecimais com `openssl rand -hex 32`. |

Abra `https://SEU-SERVICO.onrender.com/health` e confirme `{"status":"ok"}`. Em um Web Service configurado manualmente, use runtime Node, plano Free, branch main, `NODE_VERSION=24.x`, build `npm ci --omit=dev`, start `npm start` e Health Check Path `/health`. O serviço usa `PORT` do Render, com fallback para 3000.

O CRM é configurado no painel. As variáveis fixas antigas dos CRMs e `AGENDAMENTO_URL` podem ser removidas do Render. Se necessário, use `DATABASE_SSL_CA` para fornecer o certificado CA do banco em PEM ou `GHL_WEBHOOK_PUBLIC_KEY` para substituir a chave oficial Ed25519 do GoHighLevel.

### Chave de criptografia dos tokens

Os tokens CRM são criptografados com AES-256-GCM. Por padrão, a chave é derivada de `ADMIN_TOKEN`. Troque a senha do painel com `ADMIN_PASSWORD` e preserve o `ADMIN_TOKEN`. Para usar uma chave dedicada, defina `CRM_ENCRYPTION_KEY` no Render com 64 caracteres hexadecimais aleatórios **antes de cadastrar as clínicas** e mantenha essa chave estável. Se alterar a chave usada para criptografia, regrave os tokens das clínicas. O segredo do webhook Kommo é armazenado como hash para validação e de forma cifrada para permitir copiar o link no painel administrativo. A aba de conexão só exibe o link completo para um administrador autenticado. Se um cadastro antigo só tiver o hash, insira o segredo atual novamente para liberar a cópia.

O Render Free pode hibernar após 15 minutos sem tráfego. O primeiro webhook após a hibernação pode ultrapassar o prazo de resposta do CRM. A fila volta a processar os eventos já gravados quando o serviço acorda.

[Conexão PostgreSQL do Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres) · [Limites do Render Free](https://render.com/docs/free)

## Cadastrar pessoas

O administrador principal pode usar seu e-mail com `ADMIN_EMAIL` e `ADMIN_PASSWORD` no Render. Outras pessoas abrem **Criar conta** e solicitam acesso com seu próprio e-mail. Em **Contas e acessos**, o administrador seleciona uma clínica para cada pessoa e gera um link de uso único que expira em 48 horas. Envie o link manualmente para o endereço cadastrado. Ao abri-lo, a pessoa define sua própria senha e passa a entrar com seu e-mail.

Uma conta de equipe pode editar o treinamento, os feedbacks e os arquivos da clínica atribuída e usar seu simulador. O administrador mantém as conexões dos CRMs, a fila e a gestão de acessos. **Revogar acesso** encerra as sessões da conta.

## Cadastrar clínicas

1. Abra `/admin/treinar` no domínio do serviço. O painel leva à página de login. Enquanto o par personalizado estiver incompleto ou inválido, use **admin@robocrc.local** e o valor atual de `ADMIN_TOKEN` como senha. Para personalizar, configure os dois campos em **Render → Environment**, com e-mail válido e senha de 8 a 1.024 caracteres. A sessão usa cookie HTTPS com duração de 8 horas. **Sair** encerra a sessão atual.
2. Clique em **+ Nova Clínica**, informe o nome e salve. As abas ficam disponíveis na hora. A clínica aparece como **Em configuração** até conectar um CRM.
3. Em **Conexão & CRM**, escolha Kommo ou GoHighLevel e informe a conta, o token, os IDs de funil, a etapa de agendamento e o responsável. A conta e o provedor ficam fixos após conectar. Clique em **Copiar Link** para configurar o webhook.
4. Configure a URL no CRM e valide um evento por clínica. A fila, o histórico e a operação ficam separados por clínica. O login administrativo é central e gerencia todos os cadastros. Use a busca da barra lateral para localizar uma clínica. Em **Conexão & CRM**, o status **Inativa** suspende novos eventos e deixa os já enfileirados aguardando reativação. Um evento já em processamento pode concluir.

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

## Informações da clínica

Em **Informações da Clínica**, cadastre endereço, referência, horário, telefone, profissionais e serviços. Cada serviço pode ter valor ou faixa, duração, formas de pagamento e convênios. Use **Adicionar** ou **Remover** conforme necessário e clique em **Salvar informações**. O formulário aceita até 20 profissionais e 20 serviços por clínica. Em **Observações gerais**, inclua diferenciais, regras e orientações de preparo que podem ser compartilhadas. Use uma orientação por linha, com até 320 caracteres por linha.

O simulador e o atendimento real carregam o cadastro da clínica junto ao treinamento, feedbacks e documentos. Quando a pergunta identifica um dado cadastrado, ele tem prioridade na resposta. O link oficial do Google Maps pode ser aberto no painel. Pelo chat, o robô informa o endereço cadastrado e encaminha o pedido de agendamento à equipe.

## Feedbacks, arquivos e simulador

- Use **Feedbacks & Aprendizado** para salvar correções de comportamento e exemplos da clínica. Os feedbacks ficam no Supabase e são incluídos na próxima consulta à IA. Cada clínica pode manter até 16 feedbacks de 1.600 bytes cada. Exclua os que deixarem de valer. Para autorizar o envio de uma frase nova, publique-a no treinamento.

- Na aba **Arquivos (Base de Conhecimento)**, **Treinamento & Prompts** ou **Feedbacks & Aprendizado**, envie PDF, DOCX, TXT ou CSV. Você pode arrastar um arquivo ou selecioná-lo. O painel lista nome e data e permite visualizar o texto extraído ou excluir o documento. São aceitos até 5 MB por arquivo, 160 KB de texto extraído e 30 arquivos por clínica. PDFs escaneados precisam passar por OCR antes do envio.
- O Supabase guarda o texto extraído por clínica. O agente consulta até quatro trechos relevantes dos documentos junto com o treinamento. Para autorizar uma frase que possa ser enviada ao lead, coloque-a em um bloco de respostas aprovadas no treinamento.
- Para uma simulação rápida, abra **Simular atendimento** no menu lateral e preencha apenas o nome da clínica. Esse teste usa respostas genéricas, sem criar cadastros ou acionar o CRM.
- Para usar dados e treinamento salvos, selecione uma clínica cadastrada no simulador e mantenha **Simulação sem IA** marcada para testar com as respostas aprovadas e as regras locais de agendamento e transbordo. Desmarque para usar o provedor de IA configurado. Nesse modo, **Incluir documentos** permite incluir ou excluir os arquivos do teste. O painel só lista documentos enviados ao provedor. Alterar o modo ou a seleção de documentos inicia uma nova conversa.

## Agenda autônoma

- Use **Atendimento Autônomo Ativo** em **Conexão & CRM** para alternar o atendimento. Uma operação que já estiver em execução pode concluir.
- No GoHighLevel, preencha o **ID do calendário**, o fuso IANA e a duração correspondente ao calendário. O token precisa de `calendars.readonly` e `calendars/events.write`, além dos escopos do CRM. Configure a etapa de destino como **Agendado**. O agente oferece até duas vagas reais, valida a escolha e confirma a reserva antes de mover a oportunidade.
- Para Kommo ou GoHighLevel com agenda externa, preencha **Link público de reservas**. O serviço acrescenta `crc_ref` ao link. Configure a agenda ou sua automação para repassar essa referência quando houver reserva confirmada. Envie um POST JSON ao **Webhook de confirmações da agenda externa** mostrado no painel. Use `Authorization: Bearer TOKEN` com o token específico dessa clínica e o corpo `{"reference":"VALOR_DE_CRC_REF","appointmentId":"ID_DA_RESERVA","status":"confirmed"}`. Reenvios da mesma confirmação são deduplicados.
- O simulador usa horários de exemplo e não escreve dados no CRM. Clínicas sem agenda configurada continuam com encaminhamento à equipe. O atendimento usa o histórico que ainda está disponível, com limite de contexto para o provedor e retenção de até 30 dias.

## Atendimento consultivo

O robô aplica SPIN Selling para entender a situação, acolher o incômodo, perguntar pelo impacto na rotina e propor uma avaliação. Cada mensagem tem no máximo uma pergunta. Dúvidas sobre informações cadastradas podem ser respondidas diretamente, e o interesse em agendar interrompe as perguntas de descoberta.

Para preços, cadastre o serviço, o valor ou faixa e o que está incluso em **Informações da Clínica**. O robô acolhe o primeiro pedido e contextualiza a avaliação. Com contexto ou insistência, informa somente o preço do serviço encontrado no cadastro. Quando o lead prefere pensar, o robô esclarece dúvidas sem pressionar. Manhã e tarde registram preferências para a equipe verificar no ERP.

## Operar o agente

- **Resposta.** O Gemini, com contingência da OpenAI, escolhe uma resposta aprovada, formula um acolhimento breve ou indica transbordo. O servidor conduz a qualificação para agendamento. O servidor só aceita uma ferramenta por mensagem e produz a saída usando frases fixas ou publicadas. Para pedidos de avaliação conhecidos, há também redirecionamento programático para a sessão.
- **Agendamento.** A decisão requer evidência literal da mensagem atual, validada pelo servidor. Um aceite curto exige oferta de agenda no turno anterior da mesma conversa. Se faltar o objetivo em um pedido genérico, o robô pergunta qual especialidade ou tipo de consulta o lead procura. Ao aceitar a avaliação, o lead escolhe manhã ou tarde. O robô pede nome completo e telefone ou WhatsApp se ainda faltarem, um por mensagem. Em seguida, move a oportunidade no CRM quando possível, pausa a conversa, cria uma tarefa com o turno preferido e os dados informados e avisa o lead do encaminhamento. A equipe confirma os horários e registra o agendamento no ERP.
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
│   ├── multi-clinica.sql
│   ├── painel-clinicas.sql
│   └── admin-saas.sql
├── knowledge/
│   ├── faq.md
│   ├── quebra_objecoes.md
│   └── regras_negocio.md
├── src/
│   ├── admin-assets/
│   ├── admin-view.js
│   ├── admin.js
│   ├── agent.js
│   ├── clinics.js
│   ├── config.js
│   ├── crm.js
│   ├── database.js
│   ├── documents.js
│   ├── knowledge.js
│   ├── server.js
│   ├── simulator.js
│   ├── store.js
│   ├── webhooks.js
│   └── worker.js
├── test/sdr.test.js
├── package.json
└── package-lock.json
```
