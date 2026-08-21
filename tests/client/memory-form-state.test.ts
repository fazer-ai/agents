import { describe, expect, test } from "bun:test";
import {
  compactionReaderKeys,
  memoryToForm,
  memoryToStored,
} from "@/client/pages/agents/memoryFormState";
import {
  overrideBaseUrlInvalid,
  overrideBaseUrlUnsupported,
} from "@/client/pages/agents/modelOverrideForm";
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

// The Behavior tab's Save is blocked while either of these holds, and the summariser's fields live
// inside a section the operator can switch OFF, which hides them. The TTS override already carried
// this precondition, in its adapter and in its own tests; the summariser's arrived calling the
// shared helper directly and skipped both, which is how review found it. The rule lives in the
// shared helper now, as a required argument, so these are over that.
const AGENT = { provider: "openai", credentialRef: "vault:1", baseURL: "" };
const BROKEN = {
  provider: "openai-compatible",
  model: "local-small",
  credentialRef: "",
  baseURL: "llama:8080",
};

describe("the summariser's endpoint never freezes a hidden section", () => {
  test("with compaction on, a broken endpoint blocks the save", () => {
    expect(overrideBaseUrlInvalid(BROKEN, AGENT, null, true)).toBe(true);
  });

  // The state that has to stay reachable: an override saved through REST or MCP that cannot run,
  // on an agent whose operator then turns compaction off. Reporting it would freeze the tab with
  // nothing on screen to explain it, including the save that turns the section off.
  test("with compaction off, the same bag reports nothing", () => {
    expect(overrideBaseUrlInvalid(BROKEN, AGENT, null, false)).toBe(false);
  });

  test("the unsupported-endpoint half is gated the same way", () => {
    const onKeyedVendor = {
      provider: "anthropic",
      model: "",
      credentialRef: "vault:9",
      baseURL: "",
    };
    expect(
      overrideBaseUrlUnsupported(
        onKeyedVendor,
        AGENT,
        "https://proxy.example/v1",
        true,
      ),
    ).toBe(true);
    expect(
      overrideBaseUrlUnsupported(
        onKeyedVendor,
        AGENT,
        "https://proxy.example/v1",
        false,
      ),
    ).toBe(false);
  });
});
