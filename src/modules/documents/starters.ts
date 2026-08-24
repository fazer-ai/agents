import {
  DOCUMENT_STYLE_DEFAULTS,
  type DocumentBlock,
  type DocumentField,
  type DocumentStyle,
} from "./blocks";

// Ready-made templates, offered as "start from a model" in the console.
//
// They are not a nicety. Blocks are created through the API and MCP only — the console edits the
// text of a `text` block and nothing else — so without these, an operator opening the tab on day one
// meets an empty state with no way out of it, and the whole feature is unreachable from the product
// it ships in. The scope cut ("only text is editable") is only honest because the text is already
// there to edit.
//
// The structure is written ONCE and the strings come from a per-locale table: three templates in two
// languages authored separately would drift, and a starter whose English version has a block its
// Portuguese version lacks is a bug nobody would look for.

export interface DocumentStarter {
  key: string;
  name: string;
  description: string;
  numberPrefix: string;
  blocks: DocumentBlock[];
  fields: DocumentField[];
  style: DocumentStyle;
}

type Strings = Record<string, string>;

const STRINGS: Record<DocumentStyle["locale"], Strings> = {
  "pt-BR": {
    quoteName: "Orçamento",
    quoteDescription: "Orçamento com itens, desconto e validade.",
    quotePrefix: "ORC-",
    quoteIntro:
      "Prezado(a) {{cliente}},\n\nAgradecemos o contato. Segue o orçamento com os itens combinados.",
    quoteTerms:
      "**Condições**\n- Validade da proposta: {{validade}}\n- Os valores incluem os itens listados acima.\n- Prazos são confirmados após a aprovação.",
    proposalName: "Proposta comercial",
    proposalDescription:
      "Proposta com escopo em texto e um valor fechado, sem tabela de itens.",
    proposalPrefix: "PROP-",
    proposalIntro:
      "Prezado(a) {{cliente}},\n\nEsta proposta descreve o escopo do trabalho e o investimento correspondente.",
    proposalScopeTitle: "Escopo",
    proposalNext:
      "**Próximos passos**\n- Confirme a aprovação respondendo a esta mensagem.\n- Iniciamos em até 5 dias úteis após a confirmação.",
    receiptName: "Recibo",
    receiptDescription: "Recibo simples de pagamento recebido.",
    receiptPrefix: "REC-",
    receiptBody:
      "Recebemos de **{{cliente}}** a importância de **{{valor}}**, referente a {{referencia}}.\n\nPara clareza, firmamos o presente recibo.",
    emitted: "Emitido em {{doc_date}}",
    customer: "Cliente",
    validity: "Validade",
    items: "Itens",
    discount: "Desconto",
    scope: "Escopo do trabalho",
    amount: "Valor",
    reference: "Referência",
    paidAt: "Data do pagamento",
    investment: "Investimento",
  },
  "en-US": {
    quoteName: "Quote",
    quoteDescription: "Quote with line items, discount and a validity date.",
    quotePrefix: "Q-",
    quoteIntro:
      "Dear {{cliente}},\n\nThank you for getting in touch. Here is the quote for the items we discussed.",
    quoteTerms:
      "**Terms**\n- Quote valid until: {{validade}}\n- The amounts cover the items listed above.\n- Lead times are confirmed once the quote is approved.",
    proposalName: "Proposal",
    proposalDescription:
      "Proposal with a written scope and a single fixed price, no item table.",
    proposalPrefix: "P-",
    proposalIntro:
      "Dear {{cliente}},\n\nThis proposal sets out the scope of the work and the corresponding investment.",
    proposalScopeTitle: "Scope",
    proposalNext:
      "**Next steps**\n- Reply to this message to approve.\n- We start within 5 business days of approval.",
    receiptName: "Receipt",
    receiptDescription: "Simple receipt for a payment received.",
    receiptPrefix: "R-",
    receiptBody:
      "Received from **{{cliente}}** the amount of **{{valor}}**, for {{referencia}}.\n\nThis receipt is issued as confirmation.",
    emitted: "Issued on {{doc_date}}",
    customer: "Customer",
    validity: "Valid until",
    items: "Items",
    discount: "Discount",
    scope: "Scope of work",
    amount: "Amount",
    reference: "Reference",
    paidAt: "Payment date",
    investment: "Investment",
  },
};

function style(locale: DocumentStyle["locale"]): DocumentStyle {
  return {
    ...DOCUMENT_STYLE_DEFAULTS,
    locale,
    currency: locale === "pt-BR" ? "BRL" : "USD",
    accentColor: "#1d4ed8",
    footerText: "{{company_name}} · {{doc_number}}",
  };
}

function starters(locale: DocumentStyle["locale"]): DocumentStarter[] {
  const s = STRINGS[locale];
  const base = style(locale);
  return [
    {
      key: "quote",
      name: s.quoteName as string,
      description: s.quoteDescription as string,
      numberPrefix: s.quotePrefix as string,
      style: base,
      fields: [
        {
          name: "cliente",
          label: s.customer as string,
          type: "text",
          required: true,
        },
        {
          name: "itens",
          label: s.items as string,
          type: "lineItems",
          required: true,
        },
        { name: "desconto", label: s.discount as string, type: "currency" },
        // Required, because the prose PRINTS it: the terms line says "valid until" and the field's
        // value follows it. Optional, an omitted value renders that sentence with a blank after the
        // colon — a document that asks a question of its own reader.
        {
          name: "validade",
          label: s.validity as string,
          type: "date",
          required: true,
        },
      ],
      blocks: [
        {
          id: "header",
          type: "header",
          title: "{{doc_title}} {{doc_number}}",
          subtitle: s.emitted as string,
          meta: [{ label: s.customer as string, value: "{{cliente}}" }],
        },
        { id: "intro", type: "text", text: s.quoteIntro as string },
        { id: "items", type: "lineItems", field: "itens" },
        {
          id: "totals",
          type: "totals",
          field: "itens",
          discountField: "desconto",
        },
        { id: "divider", type: "divider" },
        { id: "terms", type: "text", text: s.quoteTerms as string },
      ],
    },
    {
      key: "proposal",
      name: s.proposalName as string,
      description: s.proposalDescription as string,
      numberPrefix: s.proposalPrefix as string,
      style: base,
      fields: [
        {
          name: "cliente",
          label: s.customer as string,
          type: "text",
          required: true,
        },
        {
          name: "escopo",
          label: s.scope as string,
          type: "text",
          required: true,
        },
        {
          name: "valor",
          label: s.investment as string,
          type: "currency",
          required: true,
        },
        // Required, because the prose PRINTS it: the terms line says "valid until" and the field's
        // value follows it. Optional, an omitted value renders that sentence with a blank after the
        // colon — a document that asks a question of its own reader.
        {
          name: "validade",
          label: s.validity as string,
          type: "date",
          required: true,
        },
      ],
      blocks: [
        {
          id: "header",
          type: "header",
          title: "{{doc_title}} {{doc_number}}",
          subtitle: s.emitted as string,
          meta: [{ label: s.customer as string, value: "{{cliente}}" }],
        },
        { id: "intro", type: "text", text: s.proposalIntro as string },
        {
          id: "scope-title",
          type: "text",
          text: s.proposalScopeTitle as string,
          variant: "heading",
          spaceAfter: "sm",
        },
        { id: "scope", type: "text", text: "{{escopo}}" },
        {
          id: "price",
          type: "fields",
          rows: [
            { label: s.investment as string, value: "{{valor}}" },
            { label: s.validity as string, value: "{{validade}}" },
          ],
          columns: 2,
        },
        { id: "divider", type: "divider" },
        { id: "next", type: "text", text: s.proposalNext as string },
      ],
    },
    {
      key: "receipt",
      name: s.receiptName as string,
      description: s.receiptDescription as string,
      numberPrefix: s.receiptPrefix as string,
      style: base,
      fields: [
        {
          name: "cliente",
          label: s.customer as string,
          type: "text",
          required: true,
        },
        {
          name: "valor",
          label: s.amount as string,
          type: "currency",
          required: true,
        },
        {
          name: "referencia",
          label: s.reference as string,
          type: "text",
          required: true,
        },
        // Required for the same reason: the receipt's own header row prints it.
        {
          name: "pago_em",
          label: s.paidAt as string,
          type: "date",
          required: true,
        },
      ],
      blocks: [
        {
          id: "header",
          type: "header",
          title: "{{doc_title}} {{doc_number}}",
          subtitle: s.emitted as string,
        },
        { id: "body", type: "text", text: s.receiptBody as string },
        {
          id: "detail",
          type: "fields",
          rows: [
            { label: s.amount as string, value: "{{valor}}" },
            { label: s.paidAt as string, value: "{{pago_em}}" },
          ],
          columns: 2,
        },
      ],
    },
  ];
}

export function documentStarters(
  locale: DocumentStyle["locale"] = "pt-BR",
): DocumentStarter[] {
  return starters(locale);
}

export function documentStarter(
  key: string,
  locale: DocumentStyle["locale"] = "pt-BR",
): DocumentStarter | null {
  return starters(locale).find((s) => s.key === key) ?? null;
}
