import { expect, test } from "bun:test";
import type { TenantContext } from "@/lib/tenancy";
import { listTtsOptions } from "@/modules/tts/listing";

// ElevenLabs lists each voice with a `preview_url`, and the console plays it beside the option. The
// URL goes straight into an <audio> element, so a value that is not an absolute https URL must not
// reach it: a cloned voice answers null, and a relative path would resolve against the console.

const ctx: TenantContext = { tenantId: 1n, userId: null, role: "TENANT_ADMIN" };

function listsVoices(voices: unknown[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ voices }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

test("each voice carries its own sample, and only an https URL is kept", async () => {
  const items = await listTtsOptions(
    ctx,
    { provider: "elevenlabs", kind: "voices", credentialRef: "vault:1" },
    null as never,
    listsVoices([
      {
        voice_id: "a",
        name: "Raquel",
        preview_url: "https://cdn.test/a.mp3",
        verified_languages: [
          {
            language: "pt",
            locale: "pt-BR",
            model_id: "eleven_flash_v2_5",
            preview_url: "https://cdn.test/a-pt.mp3",
          },
          {
            language: "es",
            locale: null,
            preview_url: "https://cdn.test/a-es.mp3",
          },
          { language: "fr", locale: "fr-FR", preview_url: null },
          { language: "de", preview_url: "http://cdn.test/a-de.mp3" },
        ],
      },
      { voice_id: "b", name: "Bruno", preview_url: "https://cdn.test/b.mp3" },
      { voice_id: "c", name: "Clone", preview_url: null },
      { voice_id: "d", name: "Plain", preview_url: "http://cdn.test/d.mp3" },
      { voice_id: "e", name: "Relative", preview_url: "/d.mp3" },
    ]),
    async (url: string) => new URL(url),
    async () => "fake-api-key",
  );
  // Each language keeps its own sample; one with no https sample is dropped, not played as empty.
  expect(items[0]?.languageSamples).toEqual([
    { language: "pt", locale: "pt-BR", url: "https://cdn.test/a-pt.mp3" },
    { language: "es", url: "https://cdn.test/a-es.mp3" },
  ]);
  expect(items[1]?.languageSamples).toBeUndefined();
  expect(items.map((i) => [i.id, i.previewUrl])).toEqual([
    ["a", "https://cdn.test/a.mp3"],
    ["b", "https://cdn.test/b.mp3"],
    ["c", undefined],
    ["d", undefined],
    ["e", undefined],
  ]);
});
