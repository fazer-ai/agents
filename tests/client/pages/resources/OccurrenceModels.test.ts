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
    const endpoint = {
      field: "baseURL",
      message: "Type the base URL.",
    } as const;
    expect(modelProblem(compatible, t, null)).toEqual(endpoint);
    expect(modelProblem({ ...compatible, credentialRef: "" }, t)).toEqual(
      endpoint,
    );
  });

  test("an openai-compatible model left on the provider default asks for the model id", () => {
    expect(modelProblem({ ...compatible, model: "" }, t, null)).toEqual({
      field: "model",
      message: "Type the model id.",
    });
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
