# 03: Implementação conduzida

1. **Pergunte proativamente** o que o desenvolvedor quer implementar; não assuma o escopo.
2. **Desenhe desafiando premissas** (o projeto valoriza questionar antes de executar): aponte problemas, proponha alternativas com justificativa concreta no código ou nas refs.
3. **Implemente no estilo do código vizinho**: mesma densidade de comentários, naming e idioma. Comentário que documenta um símbolo (cabeçalho do módulo, docstring acima da declaração) vai sem tag; comentário dentro de um corpo leva tag (`// TODO:`, `// NOTE:`, `// FIXME:`). Duas posições ficam de fora, porque nelas a tag não marca nada: comentário **JSX** documenta o elemento logo abaixo e vai sem `NOTE:` (`TODO:`/`FIXME:` continuam valendo, e a cerca é `tests/lib/jsx-comment-tag-sweep.test.ts`), e **diretiva de máquina** nunca leva tag, porque o `biome-ignore` só é honrado no começo do próprio comentário e a tag mata a supressão em silêncio.
4. **Respeite a marcação Free/Full** (`references/02-free-full-and-invariants.md`) em tudo que adicionar; confira o `.env.example` ao adicionar env var.
5. **Valide:** `bun check` verde antes de concluir.

Estilo: sem em-dash; `fazer.ai` sempre minúsculo; PT-BR com acentuação onde houver texto pt-BR.
