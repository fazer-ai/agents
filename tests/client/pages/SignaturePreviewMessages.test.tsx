/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import {
  BehaviorTab,
  type SignatureState,
} from "@/client/pages/agents/BehaviorTab";
import { behaviorTabProps } from "./behaviorTabProps";

// A REPETITION NOBODY ASKED FOR IS READ AS A BUG.
//
// #616 gave the signature preview one balloon per message, which is the only way to show that the
// signature repeats and which of two messages `once` signs. What it did not do is say that the two
// balloons ARE two messages: the label reads "Preview" and the hint "an example reply", singular,
// so two boxes carrying the same first line come out looking like the same preview rendered twice.
// It was reported as exactly that — the preview section is duplicated.
//
// The caption is therefore load-bearing, and so is its absence: with the split off there is one
// message and "message 1 of 1" is noise on a delivery with no repetition to show.
//
// NOTE: every assertion reduces to a number or a boolean BEFORE expect. A failing expectation
// holding a DOM node serializes a cyclic happy-dom tree and stalls the runner.

const SIGNATURE: SignatureState = {
  enabled: true,
  text: "Alex",
  position: "top",
  frequency: "all",
  separator: "blank",
};

const SPLIT = {
  maxChars: "300",
  typingWpm: "200",
  maxDelayMs: "0",
};

function renderTab(
  splitEnabled: boolean,
  signature: Partial<SignatureState> = {},
): void {
  render(
    <BehaviorTab
      {...behaviorTabProps({
        signature: { ...SIGNATURE, ...signature },
        split: { ...SPLIT, enabled: splitEnabled },
      })}
    />,
  );
}

// Both languages: the suite renders under English, the app ships under pt-BR.
const CAPTION = /^(Message \d+ of \d+|Mensagem \d+ de \d+)$/;
const SPLIT_SENTENCE =
  /(arrives as more than one message|chega em mais de uma mensagem)/;

// The NUMBERS the captions carry, not their sentence: which language the tab rendered under is
// not what any of this is about, and the digits are the same in both.
const captions = (): string[] =>
  screen
    .queryAllByText(CAPTION)
    .map((el) => (el.textContent ?? "").match(/\d+/g)?.join("/") ?? "");

// The caption's own message container, as text: the caption sits above the balloon it names.
const messageText = (n: number): string =>
  screen.queryAllByText(CAPTION)[n]?.parentElement?.textContent ?? "";

describe("the signature preview says its balloons are separate messages", () => {
  afterEach(() => cleanup());

  test("split on: each balloon is numbered, and says how many there are", () => {
    renderTab(true);
    expect(captions()).toEqual(["1/2", "2/2"]);
  });

  // The number alone says "there are two of these"; it does not say WHY, and the operator who did
  // not connect it to the split section is the one who reported the duplication.
  test("split on: the hint names the setting that produced the second message", () => {
    renderTab(true);
    expect(screen.queryAllByText(SPLIT_SENTENCE).length).toBeGreaterThan(0);
  });

  test("split off: one balloon, no number on it, and no sentence about a split", () => {
    renderTab(false);
    expect(captions()).toEqual([]);
    expect(screen.queryAllByText(SPLIT_SENTENCE).length).toBe(0);
  });

  // The half of `once` that a single bubble could never show, and that the number is what makes
  // readable: the operator can see which of the two messages carries the signature.
  test("once + top: the number points at the message that carries the signature", () => {
    renderTab(true, { frequency: "once", position: "top" });
    expect(captions()).toEqual(["1/2", "2/2"]);
    expect(messageText(0).includes("Alex")).toBe(true);
    expect(messageText(1).includes("Alex")).toBe(false);
  });

  test("once + bottom: it points at the last one instead", () => {
    renderTab(true, { frequency: "once", position: "bottom" });
    expect(messageText(0).includes("Alex")).toBe(false);
    expect(messageText(1).includes("Alex")).toBe(true);
  });
});
