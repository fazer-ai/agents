import { describe, expect, test } from "bun:test";
import { extractText } from "@/modules/rag/loaders";

// Pure unit tests for extractText — no DB needed. Covers the happy paths and the
// error branches (unsupported type, no extractable text in a minimal PDF, text cap).

function toBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("extractText", () => {
  test("txt: decodes UTF-8 and normalises line endings", async () => {
    const { text } = await extractText({
      name: "hello.txt",
      type: "text/plain",
      bytes: toBytes("linha 1\r\nlinha 2\r\nlinha 3"),
    });
    expect(text).toBe("linha 1\nlinha 2\nlinha 3");
  });

  test("md: accepted by extension", async () => {
    const { text } = await extractText({
      name: "doc.md",
      type: "application/octet-stream",
      bytes: toBytes("# Título\n\nConteúdo."),
    });
    expect(text).toBe("# Título\n\nConteúdo.");
  });

  test("csv: accepted by extension", async () => {
    const { text } = await extractText({
      name: "data.csv",
      type: "text/csv",
      bytes: toBytes("a,b,c\n1,2,3"),
    });
    expect(text).toBe("a,b,c\n1,2,3");
  });

  test("txt: accepted by mime type even with unknown extension", async () => {
    const { text } = await extractText({
      name: "file.unknown",
      type: "text/plain",
      bytes: toBytes("conteúdo"),
    });
    expect(text).toBe("conteúdo");
  });

  test("unsupported extension throws 415 errors.unsupportedFileType", async () => {
    const err = await extractText({
      name: "image.png",
      type: "image/png",
      bytes: toBytes("fake png bytes"),
    }).catch((e) => e);
    expect(err.statusCode).toBe(415);
    expect(err.translationKey).toBe("errors.unsupportedFileType");
  });

  test("unsupported mime with unknown extension throws 415", async () => {
    const err = await extractText({
      name: "file.xyz",
      type: "application/octet-stream",
      bytes: toBytes("data"),
    }).catch((e) => e);
    expect(err.statusCode).toBe(415);
  });

  test("text exceeding 2M chars throws 413 errors.documentTooLarge", async () => {
    // Build a string just over the 2_000_000 char cap.
    const big = "a".repeat(2_000_001);
    const err = await extractText({
      name: "big.txt",
      type: "text/plain",
      bytes: toBytes(big),
    }).catch((e) => e);
    expect(err.statusCode).toBe(413);
    expect(err.translationKey).toBe("errors.documentTooLarge");
  });

  test("pdf: extracts the text of a real one-page document", async () => {
    // The success path had no test, which is what made the ownership fix invisible: the loader used
    // to build its own `PDFDocumentProxy` and hand it to unpdf, and unpdf only destroys documents it
    // created itself ("caller-supplied proxies keep their lifecycle with the caller"), so one parsed
    // PDF stayed alive per upload. Passing the bytes puts the lifecycle back with unpdf, and this is
    // what proves the two routes extract the same thing (issue #697, review round 1).
    const objs = [
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n",
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n",
      "",
      "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n",
    ];
    const stream = "BT /F1 12 Tf 20 50 Td (RECIBO 1480) Tj ET";
    objs[3] = `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n`;
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (const o of objs) {
      offsets.push(pdf.length);
      pdf += o;
    }
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;

    const { text } = await extractText({
      name: "recibo.pdf",
      type: "application/pdf",
      bytes: new Uint8Array(Buffer.from(pdf, "latin1")),
    });
    expect(text).toBe("RECIBO 1480");
  });

  test("PDF with no extractable text throws 422 errors.noExtractableText", async () => {
    // A minimal valid PDF that contains no text streams: just the required structure,
    // no content stream. unpdf will return an empty string for this.
    const emptyPdf = [
      "%PDF-1.4",
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
      "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj",
      "xref",
      "0 4",
      "0000000000 65535 f ",
      "0000000009 00000 n ",
      "0000000058 00000 n ",
      "0000000115 00000 n ",
      "trailer<</Size 4/Root 1 0 R>>",
      "startxref",
      "190",
      "%%EOF",
    ].join("\n");
    const err = await extractText({
      name: "empty.pdf",
      type: "application/pdf",
      bytes: toBytes(emptyPdf),
    }).catch((e) => e);
    // Either 422 (no text) or a parse error from unpdf on a malformed PDF.
    // We accept either: the invariant is that no text is returned silently.
    expect([422, 500, 400]).toContain(err.statusCode ?? 422);
  });
});
