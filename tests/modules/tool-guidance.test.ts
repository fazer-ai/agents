import { describe, expect, test } from "bun:test";
import { readToolGuidance } from "@/modules/agents/tool-guidance";

describe("readToolGuidance", () => {
  test("keeps valid native-tool keys with trimmed text", () => {
    const g = readToolGuidance({
      toolGuidance: {
        set_custom_attribute: "  grave lead_stage  ",
        set_labels: "vip = premium",
      },
    });
    expect(g).toEqual({
      set_custom_attribute: "grave lead_stage",
      set_labels: "vip = premium",
    });
  });

  test("drops unknown keys and blank values", () => {
    const g = readToolGuidance({
      toolGuidance: {
        not_a_tool: "ignore me",
        set_labels: "   ",
        set_custom_attribute: "",
      },
    });
    expect(g).toEqual({});
  });

  test("absent / malformed settings → empty map", () => {
    expect(readToolGuidance(undefined)).toEqual({});
    expect(readToolGuidance({})).toEqual({});
    expect(readToolGuidance({ toolGuidance: "nope" })).toEqual({});
    expect(readToolGuidance({ toolGuidance: ["nope"] })).toEqual({});
  });

  test("caps overly long notes", () => {
    const g = readToolGuidance({
      toolGuidance: { set_labels: "x".repeat(5000) },
    });
    expect((g.set_labels ?? "").length).toBeLessThanOrEqual(1500);
  });
});
