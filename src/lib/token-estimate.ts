import { estimateTokenCount } from "tokenx";

// THE ONE TOKEN ESTIMATE the server and the console share, so a number the agent editor shows and the
// history ceiling it sits next to (graph/token-count.ts) speak the same unit. `tokenx` is a heuristic
// calibrated against o200k_base: it runs LOW against what OpenAI bills (measured ~17% under on a
// thread with tools) and is only an approximation for other providers. Every surface that shows it
// says "~" and says it may run low; no correction factor, since one that fits one content mix is wrong
// for the next. Figures in docs/graph.md, History ceiling.
export function estimateTokens(text: string): number {
  return text ? estimateTokenCount(text) : 0;
}
