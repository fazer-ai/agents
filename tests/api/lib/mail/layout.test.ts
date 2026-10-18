import { describe, expect, test } from "bun:test";
import { requestContext } from "@/api/lib/i18n";
import { EMAIL_THEME, escapeHtml, renderEmail } from "@/api/lib/mail/layout";

// reads the two token blocks the way theme-contrast.test.ts does: the
// dark defaults in `@theme static`, the light overrides in
// `html[data-theme="light"]`.
async function themeTokens() {
  const css = await Bun.file("public/index.css").text();
  const block = (start: string) => {
    const from = css.indexOf(start);
    if (from === -1) throw new Error(`missing block ${start}`);
    const end = css.indexOf("\n}", from);
    return css.slice(from, end);
  };
  const parse = (source: string) =>
    Object.fromEntries(
      [...source.matchAll(/--color-([\w-]+):\s*([^;]+);/g)].map((m) => [
        m[1],
        m[2]?.trim(),
      ]),
    );
  return {
    dark: parse(block("@theme static")),
    light: parse(block('html[data-theme="light"]')),
  };
}

describe("the email palette", () => {
  // mail clients need literal colors, so EMAIL_THEME is a copy. This is
  // what stops a retheme of the app from leaving the mail in the old palette.
  test("every color matches its token in public/index.css", async () => {
    const tokens = await themeTokens();
    for (const scheme of ["light", "dark"] as const) {
      for (const [name, value] of Object.entries(EMAIL_THEME[scheme])) {
        expect(`${scheme} ${name}: ${value}`).toBe(
          `${scheme} ${name}: ${tokens[scheme][name]}`,
        );
      }
    }
  });
});

describe("renderEmail", () => {
  const content = {
    subject: "Subject <b>",
    brandName: "Acme & Co",
    preheader: "Preview line",
    blocks: [
      { type: "heading", text: "Hello <script>alert(1)</script>" },
      { type: "paragraph", text: `Tom & "Jerry"` },
      {
        type: "button",
        label: "Open",
        url: "https://app.example.com/reset-password#token=a.b-c",
      },
      { type: "note", text: "Expires soon" },
      { type: "code", text: "123 456" },
    ],
    footer: "Why you got this",
  } as const;

  test("escapes every interpolated string in the HTML part", () => {
    const { html } = renderEmail({ ...content, blocks: [...content.blocks] });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Hello &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Tom &amp; &quot;Jerry&quot;");
    expect(html).toContain("<title>Subject &lt;b&gt;</title>");
    expect(html).toContain("Acme &amp; Co");
    expect(html).not.toContain("Acme & Co");
  });

  test("builds the text part from the same blocks, link included", () => {
    const { text, html } = renderEmail({
      ...content,
      blocks: [...content.blocks],
    });
    expect(text).toContain("Hello <script>alert(1)</script>");
    expect(text).toContain(
      "Open:\nhttps://app.example.com/reset-password#token=a.b-c",
    );
    expect(text).toContain("Expires soon");
    expect(text).toContain("123 456");
    expect(text).toContain("Why you got this");
    // the button and its copy-this-link fallback both carry the URL.
    const hrefs = html.match(
      /href="https:\/\/app\.example\.com\/reset-password#token=a\.b-c"/g,
    );
    expect(hrefs?.length).toBe(2);
    expect(html).toContain(">Preview line</div>");
  });

  test("refuses a button URL that is not absolute http(s)", () => {
    for (const url of ["/reset", "javascript:alert(1)", "mailto:a@b.co"]) {
      expect(() =>
        renderEmail({
          subject: "s",
          brandName: "Acme",
          preheader: "p",
          blocks: [{ type: "button", label: "x", url }],
        }),
      ).toThrow();
    }
  });

  test("renders in the request's locale", () => {
    const { html } = requestContext.run({ locale: "pt-BR" }, () =>
      renderEmail({
        subject: "s",
        brandName: "Acme",
        preheader: "p",
        blocks: [{ type: "button", label: "x", url: "https://a.example" }],
      }),
    );
    expect(html).toContain('<html lang="pt-BR"');
    expect(html).toContain("Se o botão não funcionar");
  });

  test("escapeHtml covers the five characters that matter", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});
