import { describe, expect, test } from "bun:test";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";

// The occurrence monitor groups any reason of contact, so nothing it says may assume one business or
// one kind of reason: no "subject" and "problem" roles, no "something going wrong", no ready-made
// template, no examples, and none of one install's vocabulary (events, tickets, shows, venues). This
// reads the screen's catalog entries; the fixed prompts are checked as sent, in occurrence-themes.

function entries(obj: unknown, prefix = ""): [string, string][] {
  if (typeof obj === "string") return [[prefix, obj]];
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj).flatMap(([k, v]) =>
    entries(v, prefix ? `${prefix}.${k}` : k),
  );
}

const ofOccurrences = (catalog: unknown) =>
  entries(catalog).filter(
    ([k]) =>
      k.startsWith("occurrences.") ||
      k.startsWith("dashboards.occurrence") ||
      k.startsWith("dashboard.node.occurrence") ||
      k === "dashboards.noReference",
  );

const EN =
  /\bsubjects?\b|\bproblems?\b|going wrong|ready template|template|example|e\.g\.|\bevents?\b|\btickets?\b|\bvenues?\b|\bconcerts?\b/i;
const PT =
  /assunto|problema|dando errado|deu errado|modelo pronto|exemplo|\beventos?\b|ingresso|\bshows?\b|\blocal do\b|\bcasa de show/i;

describe("the occurrence monitor's words", () => {
  test("the English catalog names no role, example or business", () => {
    expect(ofOccurrences(en).filter(([, v]) => EN.test(v))).toEqual([]);
  });

  test("the Portuguese catalog names no role, example or business", () => {
    expect(ofOccurrences(ptBR).filter(([, v]) => PT.test(v))).toEqual([]);
  });
});
