# Sample agents

Exemplos de agentes no schema de export **`fazer-ai.agent` v1** (o mesmo formato que `POST /v1/agents/import`
/ a write tool `agent_import` do MCP consomem). Servem para testar o import, o onboarding e a documentação.

| Arquivo | Persona |
| --- | --- |
| `maria-clinica-moreira.json` | "Maria", recepção de uma clínica fictícia (Clínica Moreira): agendamento, FAQ, voz, KB. |
| `rui-transportadora-http.json` | "Rui", atendimento de uma transportadora fictícia. **O menor bundle com ferramenta HTTP declarativa**: `urlTemplate`, `allowedHosts`, contrato de entrada, `expectedStatuses` e template de resposta. É a forma que uma migração de v3 produz para o `toolWorkflow` que faz **uma chamada HTTP**. Os outros formatos não viram isto: consulta a banco, nó de código, integração nativa e subfluxo de vários passos ou vão para ferramenta nativa da V4, ou são mapeamento manual. Sem credencial: a API é pública. |

## Credenciais são por NOME, não por valor

O export **não carrega segredos**: cada credencial é referenciada por **nome** (`credentialRef`). Ao importar
num tenant novo, os refs não resolvem automaticamente: crie entradas no vault com os mesmos nomes (ou
re-aponte via `PATCH /v1/agents/:id`). Os nomes neste sample são genéricos de propósito:

- `OpenAI`: modelo (`gpt-5.4-mini`) + STT + visão.
- `ElevenLabs`: TTS.
- `Google OAuth2`: integrações Google Calendar + Drive.
- `Asaas`: integração de cobrança.

IDs específicos de ambiente foram neutralizados (ex.: o Google Calendar usa `primary`). Não há chaves,
tokens ou IDs reais no arquivo: pode versionar e publicar à vontade.

## Profissionais: prompt, KB e calendários devem contar a MESMA história

Os profissionais/especialidades aparecem em **três** lugares que o agente cruza em runtime: a tabela
`PROFISSIONAIS E ESPECIALIDADES` do prompt, o doc **"Serviços e especialidades"** da KB e os **nomes dos
calendários** vinculados na integração Google Calendar (a tool devolve esses nomes ao modelo). Se divergirem,
o agente responde listas diferentes de serviços conforme o caminho (já aconteceu: prompt dizia "Dentista",
calendários diziam "Endodontia") e tenta agendar em agendas que não existem. Ao adaptar o sample ou vincular
os calendários reais, **atualize os três juntos**. O sample vem sincronizado com os calendários da demo:
Dra. Ana Costa (Clínico Geral), Dr. Roberto Almeida (Cardiologia), Dr. Felipe Torres (Endodontia),
Dra. Beatriz Souza (Ortodontia).
