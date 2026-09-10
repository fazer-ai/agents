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

  test("cooldown: the note says the window was taken, never that a copy landed", () => {
    // Without this the second refusal inside the window looks like a bug in the copy. But it must
    // not claim delivery either: a concurrent refusal claims the copy window BEFORE it sends, so
    // the one that lost the claim cannot know whether the other's send landed — and that one may
    // still fail and hand the window back.
    const nota = contactAuthNoteText(denied, true, "suppressed");
    expect(nota).toContain("carência entre avisos");
    expect(nota).toContain("não saiu nesta mensagem");
    expect(nota).not.toContain("repetido");
  });

  // `failed` covers two different causes — the send threw, and the ownership fence stood the copy
  // down because a human took the conversation — and the call site sees the same `false` for both.
  // So the note says what is TRUE of both, the result, and never names a delivery failure that the
  // takeover case would not have.
  test("nothing reached the contact: the note says the result, not a cause", () => {
    const nota = contactAuthNoteText(denied, true, "failed");
    expect(nota).toContain("NÃO chegou ao contato");
    expect(nota).not.toContain("carência");
    expect(nota).not.toContain("envio");
    expect(nota).not.toContain("falh");
  });

  // The strongest criterion here, and the one that does not depend on the words chosen: with the
  // SAME reason code and the same handoff, the four states must read as four different notes.
  // Before the fix they were byte-for-byte identical, which is what made the note unreadable.
  test("the four outcomes are four distinct notes, and none of them leaks the contact", () => {
    const notas = (["sent", "none", "suppressed", "failed"] as const).map((c) =>
      contactAuthNoteText(denied, true, c),
    );
    expect(new Set(notas).size).toBe(4);
    for (const nota of notas) {
      expect(nota).toContain("not_customer");
      expect(nota).not.toContain("+55");
    }
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
