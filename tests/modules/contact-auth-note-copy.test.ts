import { describe, expect, test } from "bun:test";
import { contactAuthNoteText } from "@/modules/chatwoot/webhook";

// The note earns its space by carrying what is NOT on screen. It used to say "o agente não respondeu
// automaticamente" on every refusal, including the ones where the deny message had gone out one line
// above — a note that contradicts the screen. Announcing the opposite ("o contato foi avisado") is
// just as useless, for the same reason: the operator can see that message. So the note says nothing
// about a copy that WAS delivered, and speaks up in the three cases where nothing reached the
// customer, which are the ones nobody can see.
describe("contactAuthNoteText: só diz o que não está na tela", () => {
  const denied = { outcome: "denied" as const, endpointReason: "not_customer" };

  test("copy delivered: the note says NOTHING about the copy, and never claims silence", () => {
    const nota = contactAuthNoteText(denied, true, "sent");
    // Not "não respondeu" (contradicts the screen) and not "foi avisado" (redundant with it).
    expect(nota).not.toContain("não respondeu automaticamente");
    expect(nota).not.toContain("aviso");
    // What it keeps is the part the operator cannot see: the reason code, plus the handoff.
    expect(nota).toContain("not_customer");
    expect(nota).toContain("atendimento humano");
  });

  test("no deny message configured: the note says nothing reached the contact, and why", () => {
    const nota = contactAuthNoteText(denied, false, "none");
    expect(nota).toContain("Nenhum aviso foi enviado ao contato");
    expect(nota).toContain("não há mensagem de recusa configurada");
    expect(nota).not.toContain("atendimento humano");
  });

  test("cooldown: the operator learns the notice was withheld, not missing", () => {
    // Without this the second refusal inside the window looks like a bug in the copy.
    const nota = contactAuthNoteText(denied, true, "suppressed");
    expect(nota).toContain("carência entre avisos");
    expect(nota).toContain("não foi repetido");
  });

  test("send failed: named as a delivery problem, not as a decision", () => {
    const nota = contactAuthNoteText(denied, true, "failed");
    expect(nota).toContain("NÃO foi concluído");
    expect(nota).not.toContain("carência");
  });

  test("default is `none`, so an omitted argument never overclaims", () => {
    expect(contactAuthNoteText(denied, false)).toBe(
      contactAuthNoteText(denied, false, "none"),
    );
  });

  // The two verdicts that are silent to the customer BY DESIGN keep their wording: there is no copy
  // to describe, and "não respondeu automaticamente" is the whole truth there.
  // The `sent` note is the shortest of the four ON PURPOSE: everything it could add is already on
  // screen. This pins that, so nobody "improves" it back into a redundant sentence.
  test("`sent` is the shortest note of the four", () => {
    const sent = contactAuthNoteText(denied, true, "sent");
    for (const outro of ["none", "suppressed", "failed"] as const) {
      expect(sent.length).toBeLessThan(
        contactAuthNoteText(denied, true, outro).length,
      );
    }
  });

  test("no_identity and error are untouched", () => {
    expect(
      contactAuthNoteText({ outcome: "no_identity" }, false, "sent"),
    ).toContain("não respondeu automaticamente");
    expect(
      contactAuthNoteText({ outcome: "error", status: 502 }, false, "sent"),
    ).toContain("não respondeu automaticamente");
  });
});
