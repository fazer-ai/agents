# 07: Relatar um bug ou pedir uma melhoria (issue no GitHub)

Quando o diagnóstico conclui que o problema é do produto, ou quando o usuário quer pedir uma melhoria, quem escreve a issue é você: o usuário só revisa e envia. Fora do fluxo de debug, mas costuma ser o fim dele.

## 1. Separar configuração de produto

Abre issue quando o fazer.ai agents **faz diferente do que foi configurado**, ou para **pedir uma melhoria**. Não abre quando a causa é configuração do próprio usuário (endereço ou credencial errada numa ferramenta HTTP, grant faltando, agente em modo teste, conversa atribuída a um atendente, embedding do tenant sem credencial): aí o caminho é o `03-adjust.md`, e você diz ao usuário que não é caso de issue e por quê.

Vulnerabilidade de segurança **nunca** vai em issue pública: o canal é support@fazer.ai.

## 2. Conferir a versão

Pegue a versão da instância (`GET /api/health` devolve `version`; as respostas da API trazem `instance.version`; no painel, rodapé da barra lateral) e compare com a última release pública (`gh release view -R fazer-ai/agents --json tagName`, ou a página de releases). Se a instância está atrás, a primeira proposta é atualizar (fora do horário de atendimento, porque o serviço reinicia; quem conduz é o `agents-onboarding`) e testar de novo: o problema pode já ter sido corrigido. Só siga para a issue se ele continua na versão atual, ou se o usuário não pode atualizar agora (diga isso na issue).

## 3. Procurar antes de abrir

Procure em `fazer-ai/agents` nas issues **abertas e fechadas**, com dois ou três termos do sintoma (`gh issue list -R fazer-ai/agents --state all --search "<termos>"`, ou o link `https://github.com/fazer-ai/agents/issues?q=is%3Aissue+<termos>`). Achou a mesma coisa: mostre ao usuário e sugira comentar lá com a versão e o caso dele, em vez de abrir outra. Achou fechada: leia como foi fechada (corrigida em qual versão, ou recusada) antes de propor reabrir.

## 4. Redigir título e descrição

**Uma issue, uma coisa** (dimensionada para uma PR fechar). Dois problemas são duas issues.

- **Título:** o comportamento observado, específico, sem "bug" nem "erro" genérico. Bom: "Agente oferece agendamento mesmo com o prompt proibindo". Ruim: "Bug no agente".
- **Descrição**, nesta ordem:
  - **Versão** da instância e edição (Free ou Pro).
  - **Como reproduzir:** passos mínimos, de preferência no playground (`02-reproduce.md`), com a mensagem exata enviada.
  - **Esperado** e **o que aconteceu**, em frases separadas.
  - **Evidência:** o estágio e o erro do log (`01-diagnose.md`), o trecho relevante da configuração, e os anexos da seção 5.
  - Para melhoria: o problema que ela resolve e o caso concreto, não só a solução.

Escreva no idioma do usuário. Sem segredo, sem dado de cliente (nome, telefone, e-mail, CPF/CNPJ de pessoa, conteúdo de conversa real): troque por exemplo fictício.

## 5. Anexos: log e agente exportados

- **Log do caso:** `/logs` filtrado na conversa (ou no intervalo do teste) → **Exportar** → JSON; ou MCP `logs_export` (`format: "json"`, mesmos filtros do `logs_query`: `conversation_id`, `since`/`until`, `source`).
- **Configuração do agente:** editor do agente → **Exportar** → **Exportar agente**; ou MCP `agent_export`. Sai sem segredos (credenciais, ferramentas e bases aparecem pelo nome).
- **Revise os dois antes de anexar**, porque o repositório é público. O log por padrão não guarda texto de mensagem nem PII, mas se a chave **Registrar os valores enviados às ferramentas** esteve ligada durante o caso, os argumentos e resultados das ferramentas estão inteiros no log: limpe-os. O prompt exportado também pode citar dados do negócio do cliente.

## 6. Entregar o texto e o link, nunca criar a issue

Quem abre a issue é o usuário: é publicação num repositório público, e ele precisa ler o que vai sair com o nome dele. Entregue:

1. O **título** num bloco de texto e a **descrição** em outro, prontos para copiar.
2. O link da página de nova issue, sem nada preenchido: `https://github.com/fazer-ai/agents/issues/new`.
3. A lembrança de arrastar os dois anexos revisados (seção 5) para o campo da descrição.

Não crie a issue (`gh issue create`, API, MCP do GitHub) e não ofereça criar, mesmo com o `gh` autenticado na máquina. Também não monte link com título e descrição na URL: o usuário cola o texto que acabou de revisar.
