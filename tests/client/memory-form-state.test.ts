import { describe, expect, test } from "bun:test";
import {
  compactionReaderKeys,
  memoryToForm,
  memoryToStored,
} from "@/client/pages/agents/memoryFormState";
import { readMemoryConfig } from "@/modules/memory/settings";

// The Behavior save REPLACES the whole `memory` block with what the form holds, so a field the form
// does not carry is not merely un-editable: it is DELETED on the next save. That already happened
// once to `tts.baseURL`, which REST and MCP accept and the form did not. These are the two guards
// that make it impossible to repeat here silently.
describe("agent editor memory round-trip", () => {
  test("a configured summariser model survives form → stored → form", () => {
    const stored = {
      memory: {
        compaction: {
          enabled: true,
          provider: "openai",
          model: "gpt-5.4-nano",
          credentialRef: "vault:7",
          baseURL: "https://proxy.example/v1",
        },
      },
    };
    const round = memoryToStored(memoryToForm(stored));
    expect(round.compaction).toEqual({
      enabled: true,
      provider: "openai",
      model: "gpt-5.4-nano",
      credentialRef: "vault:7",
      baseURL: "https://proxy.example/v1",
    });
  });

  // A bag that predates the override, saved by an operator who only toggled the switch, has to come
  // back exactly as it went in: nulls, not empty strings, so an agent saved through this form stays
  // comparable with one that was never opened.
  test("an untouched bag round-trips to nulls, not blanks", () => {
    const round = memoryToStored(memoryToForm({}));
    expect(round.compaction).toEqual({
      enabled: true,
      provider: null,
      model: null,
      credentialRef: null,
      baseURL: null,
    });
  });

  // The guard that catches the NEXT field. `compaction` growing a key that the form does not carry
  // fails here, at the moment it is added, rather than as a value that quietly disappears on an
  // operator's next save.
  test("the form carries every key the reader produces", () => {
    const written = Object.keys(
      memoryToStored(memoryToForm({})).compaction,
    ).sort();
    expect(written).toEqual(compactionReaderKeys());
    // And the reader's own list is the one the runtime reads, not a copy kept here.
    expect(compactionReaderKeys()).toEqual(
      Object.keys(readMemoryConfig({}).compaction).sort(),
    );
  });
});
