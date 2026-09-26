# 06: Recalcular o custo das chamadas quando um preço estava errado

O custo em dólar de cada chamada de modelo é gravado junto da linha de uso, com a tabela de preços que estava valendo naquela hora. Quando uma atualização corrige o preço de um modelo, as linhas antigas continuam com o valor errado até alguém recalcular. Nada recalcula sozinho: a nota da release avisa, e o operador decide.

O comando roda **dentro do contêiner do fazer.ai agents** (ele já tem o `MIGRATION_DATABASE_URL`):

```bash
docker exec -it <contêiner do app> bun scripts/reprice-usage.ts \
  --tenant <id|all> --provider <provedor> --model <modelo> \
  [--from 2026-09-01] [--to 2026-10-01] [--price-table <litellm@…|none>] [--apply]
```

- **Sem `--apply` é simulação**: mostra, por tenant e modelo, quantas linhas casaram, quantas mudariam, quantas a tabela não sabe precificar e o total antes e depois. Não grava nada. Isso é leitura e é livre.
- **Com `--apply` grava no banco de produção.** É mutação: mostre a simulação ao usuário e só aplique com o OK dele para aquela execução. Só as linhas cujo valor muda são reescritas, e cada uma ganha o carimbo do que a precificou agora: o preço próprio do tenant (`tenant-override@…`) ou a tabela atual.
- **`--provider` é obrigatório** e tem que ser o provedor que de fato serviu aquele modelo (o mesmo do agente: `openai`, `anthropic`, `google`, `deepseek`, `openrouter`, `openai-compatible`). A linha de uso não guarda o provedor, e o mesmo nome de modelo dá preços diferentes em provedores diferentes. Na dúvida, confira na configuração do agente antes de aplicar.
- `--from` inclui o dia, `--to` não inclui. `--price-table` limita às linhas que uma tabela específica gravou; `none` pega as linhas antigas, de antes de existir o custo, que por padrão ficam de fora. Cada linha é recalculada como a captura faria hoje: primeiro o preço próprio do tenant para o modelo (inclusive um salvo depois, que é o outro motivo para rodar), depois, numa linha que a OpenRouter informou, o valor que ela cobrou, que a tabela nunca substitui, e por fim a tabela.
- Um servidor `openai-compatible` que serve um modelo sem nome grava o modelo vazio: use `--model ""` com `--provider openai-compatible`.
- Um modelo que a tabela não conhece (um servidor `openai-compatible`, por exemplo) é aceito: o preço próprio do tenant pode cobri-lo, e a saída avisa quando só essas linhas podem mudar.
- Uma linha que nada sabe precificar agora fica como está e aparece na contagem. O comando nunca troca um valor por vazio nem um vazio por zero.

Depois de aplicar, rode de novo sem `--apply`: tem que dizer que nada mais mudaria.
