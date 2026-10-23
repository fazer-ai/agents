import { describe, expect, test } from "bun:test";
import { modelProblem } from "@/client/pages/resources/OccurrenceModels";

// The model's draft says what keeps it from saving the way the round resolves it: an openai-compatible
// endpoint may come from the model or from its credential (model.ts, resolveMonitorModel).
const t = (_k: string, d: string) => d;
const compatible = {
  provider: "openai-compatible",
  model: "local-model",
  credentialRef: "vault:7",
  baseURL: "",
};

describe("modelProblem", () => {
  test("an openai-compatible model with no endpoint of its own saves on its credential's", () => {
    expect(
      modelProblem(compatible, t, "https://llm.example.com/v1"),
    ).toBeNull();
  });

  test("an openai-compatible model with no endpoint anywhere asks for one", () => {
    expect(modelProblem(compatible, t, null)).toBe("Type the base URL.");
    expect(modelProblem({ ...compatible, credentialRef: "" }, t)).toBe(
      "Type the base URL.",
    );
  });

  test("its own endpoint is enough without a credential", () => {
    expect(
      modelProblem(
        {
          ...compatible,
          credentialRef: "",
          baseURL: "http://127.0.0.1:8080/v1",
        },
        t,
      ),
    ).toBeNull();
  });
});
