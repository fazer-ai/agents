import type { TFunction } from "i18next";
import { BookOpen, Check, Copy } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal, useModalController } from "@/client/components";

// What the modal says, built once and rendered twice: as the page, and as the Markdown the copy
// button hands over (to paste into an AI assistant that writes the endpoint). Keys, decisions and
// header names are the wire format and stay in English; only the sample values and the prose follow
// the language. Held to the code by tests/client/external-check-contract.test.tsx, and in step with
// docs/guardrails-external.md.
export interface ContractBlock {
  label?: string;
  text?: string;
  code?: string;
  lang?: "json" | "js";
  testId?: string;
}
export interface ContractPart {
  title: string;
  blocks: ContractBlock[];
}

const ID = "9f2c…e41a";
const json = (v: unknown) => JSON.stringify(v, null, 2);

export function contractExamples(t: TFunction) {
  const verifyComment = t(
    "editor.guardrails.contract.example.verifyComment",
    "rawBody: the request body exactly as received, before JSON.parse",
  );
  return {
    request: json({
      version: 1,
      type: "guardrail.output",
      candidateId: ID,
      tenantId: "1",
      agentId: "2",
      conversationId: "3",
      chatwootConversationId: 42,
      turnId: "7b1d0c9e-…",
      customerMessage: t(
        "editor.guardrails.contract.example.customerMessage",
        "Does the 12-month plan include support?",
      ),
      toolCalls: [
        {
          name: "search_knowledge",
          args: {
            query: t(
              "editor.guardrails.contract.example.query",
              "12-month plan support",
            ),
          },
          result: "…",
          argsSize: 33,
          resultSize: 1840,
          isError: false,
        },
      ],
      candidate: {
        text: t(
          "editor.guardrails.contract.example.candidate",
          "Yes, the 12-month plan includes support by chat.",
        ),
        attachments: [],
        model: "primary",
      },
    }),
    allow: JSON.stringify({ candidateId: ID, decision: "allow" }),
    replace: json({
      candidateId: ID,
      decision: "replace",
      text: t(
        "editor.guardrails.contract.example.replaceText",
        "Support by chat comes with the 12-month plan.",
      ),
      reason: t(
        "editor.guardrails.contract.example.replaceReason",
        "plan wording out of date",
      ),
    }),
    block: json({
      candidateId: ID,
      decision: "block",
      reason: t(
        "editor.guardrails.contract.example.blockReason",
        "price not found in the sources the agent used",
      ),
    }),
    verify: `import { createHmac, timingSafeEqual } from "node:crypto";

// ${verifyComment}
function isSigned(headers, rawBody, secret) {
  const ts = headers["x-fazerai-timestamp"];
  const got = headers["x-fazerai-signature"] ?? "";
  const want =
    "sha256=" + createHmac("sha256", secret).update(\`\${ts}.\${rawBody}\`).digest("hex");
  return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}`,
  };
}

export function contractParts(t: TFunction): ContractPart[] {
  const ex = contractExamples(t);
  return [
    {
      title: t("editor.guardrails.contract.whenTitle", "When it is called"),
      blocks: [
        {
          text: t(
            "editor.guardrails.contract.when",
            "Once per reply to a customer message, in the inbox and in the playground, after the built-in output check and before the reply is split, turned into audio or signed. The hand-over line and a reply that is only files are asked about too. Follow-ups and nudges are not.",
          ),
        },
      ],
    },
    {
      title: t("editor.guardrails.contract.requestTitle", "Request"),
      blocks: [
        {
          text: t(
            "editor.guardrails.contract.requestHeaders",
            "POST to your URL with content-type: application/json and the x-fazerai-delivery header. The whole call, answer included, has 15 seconds.",
          ),
        },
        {
          code: ex.request,
          lang: "json",
          testId: "gr-external-contract-request",
        },
        {
          text: t(
            "editor.guardrails.contract.fieldCandidate",
            "candidateId identifies this exact reply. Your answer must repeat it.",
          ),
        },
        {
          text: t(
            "editor.guardrails.contract.fieldTools",
            "toolCalls are this turn's, in order, at most 50, each value cut to 8000 characters (argsSize and resultSize are the sizes before the cut). Secrets are redacted. With “Send tool values” off, args and result are left out.",
          ),
        },
        {
          text: t(
            "editor.guardrails.contract.fieldAttachments",
            "candidate.attachments lists the files sent with the reply (kind, fileName, caption, and text for a document the model wrote).",
          ),
        },
        {
          text: t(
            "editor.guardrails.contract.fieldPlayground",
            "In the playground, conversationId and chatwootConversationId are null.",
          ),
        },
      ],
    },
    {
      title: t("editor.guardrails.contract.signatureTitle", "Signature"),
      blocks: [
        {
          text: t(
            "editor.guardrails.contract.signature",
            "With a signing secret, each request also carries x-fazerai-timestamp and x-fazerai-signature: sha256= followed by the hex HMAC-SHA256 of “timestamp.raw body” with the secret, the same scheme as the outbound webhooks. Without one, the request goes unsigned.",
          ),
        },
        { code: ex.verify, lang: "js" },
      ],
    },
    {
      title: t("editor.guardrails.contract.responseTitle", "Response"),
      blocks: [
        {
          text: t(
            "editor.guardrails.contract.response",
            "Answer with a 2xx and a JSON body that repeats candidateId and has a decision.",
          ),
        },
        {
          label: "allow",
          text: t(
            "editor.guardrails.contract.allow",
            "the reply goes out as written.",
          ),
        },
        {
          code: ex.allow,
          lang: "json",
          testId: "gr-external-contract-allow",
        },
        {
          label: "replace",
          text: t(
            "editor.guardrails.contract.replace",
            "your text goes out instead (required, at most 4096 characters). It is split, voiced and signed like the agent's own reply and is not checked again. Any files of the reply are dropped.",
          ),
        },
        {
          code: ex.replace,
          lang: "json",
          testId: "gr-external-contract-replace",
        },
        {
          label: "block",
          text: t(
            "editor.guardrails.contract.block",
            "the reply does not go out and the Output section's “On violation” setting runs: a template message is sent, nothing is sent, or the conversation goes to the team with its message to the customer. A guardrails-generated message falls back to the template, since no model writes one here.",
          ),
        },
        {
          code: ex.block,
          lang: "json",
          testId: "gr-external-contract-block",
        },
        {
          text: t(
            "editor.guardrails.contract.reason",
            "reason is optional on replace and block (up to 500 characters). It shows in the private note and the playground, and in the flow log only while tool values are logged.",
          ),
        },
      ],
    },
    {
      title: t(
        "editor.guardrails.contract.failureTitle",
        "When the check cannot decide",
      ),
      blocks: [
        {
          text: t(
            "editor.guardrails.contract.failure",
            "No answer within 15 seconds, a status outside 2xx, a body that is not one of the decisions above, a different candidateId, a URL the outbound guard refuses, or a signing secret that no longer exists: the reply follows “When a check cannot run”. By default it goes out unchecked; with hold it is held and the conversation goes to the team.",
          ),
        },
      ],
    },
  ];
}

export function contractMarkdown(title: string, parts: ContractPart[]) {
  const out = [`# ${title}`];
  for (const p of parts) {
    out.push(`## ${p.title}`);
    for (const b of p.blocks) {
      if (b.code) out.push(`\`\`\`${b.lang ?? ""}\n${b.code}\n\`\`\``);
      else if (b.text) out.push(b.label ? `**${b.label}**: ${b.text}` : b.text);
    }
  }
  return `${out.join("\n\n")}\n`;
}

function CopyButton({
  text,
  label,
  testId,
}: {
  text: string;
  label: string;
  testId?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (insecure context); the text stays selectable.
    }
  };
  return (
    <Button size="sm" variant="secondary" onClick={copy} data-testid={testId}>
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? t("common.copied", "Copied") : label}
    </Button>
  );
}

export function ExternalCheckContract() {
  const { t } = useTranslation();
  const modal = useModalController();
  const title = t(
    "editor.guardrails.contract.title",
    "External check: request and response",
  );
  const parts = contractParts(t);
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => modal.open()}
        data-testid="gr-external-contract-open"
      >
        <BookOpen />
        {t("editor.guardrails.contract.open", "Request and response format")}
      </Button>
      <Modal
        modal={modal}
        size="lg"
        title={title}
        description={t(
          "editor.guardrails.contract.intro",
          "What your endpoint receives, what it must answer, and what happens when it cannot.",
        )}
        footer={
          <CopyButton
            text={contractMarkdown(title, parts)}
            label={t("editor.guardrails.contract.copyAll", "Copy as Markdown")}
            testId="gr-external-contract-copy-all"
          />
        }
      >
        <div
          className="max-h-[65vh] space-y-5 overflow-y-auto pr-1"
          data-testid="gr-external-contract"
        >
          {parts.map((p) => (
            <section key={p.title} className="space-y-2">
              <h3 className="font-medium text-sm text-text-primary">
                {p.title}
              </h3>
              {p.blocks.map((b) =>
                b.code ? (
                  <div key={b.code} className="relative">
                    <pre
                      className="overflow-x-auto rounded-lg border border-border bg-bg-tertiary px-3 py-2 font-mono text-text-primary text-xs"
                      data-testid={b.testId}
                    >
                      <code>{b.code}</code>
                    </pre>
                    <div className="absolute top-1.5 right-1.5">
                      <CopyButton
                        text={b.code}
                        label={t("common.copy", "Copy")}
                      />
                    </div>
                  </div>
                ) : (
                  <p
                    key={`${b.label ?? ""}${b.text}`}
                    className="text-sm text-text-secondary"
                  >
                    {b.label && (
                      <>
                        <strong className="text-text-primary">{b.label}</strong>
                        {": "}
                      </>
                    )}
                    {b.text}
                  </p>
                ),
              )}
            </section>
          ))}
        </div>
      </Modal>
    </>
  );
}
