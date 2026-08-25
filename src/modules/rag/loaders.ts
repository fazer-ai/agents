import mammoth from "mammoth";
import { getDocumentProxy, extractText as unpdfExtractText } from "unpdf";
import { AppError } from "@/lib/errors";

export const SUPPORTED_EXTENSIONS = [
  "pdf",
  "docx",
  "txt",
  "md",
  "markdown",
  "csv",
] as const;

export const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/csv",
] as const;

const TEXT_CAP = 2_000_000;

export interface FileInput {
  name: string;
  type: string;
  bytes: Uint8Array;
}

function ext(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export async function extractText(file: FileInput): Promise<{ text: string }> {
  const extension = ext(file.name);
  const mime = file.type.toLowerCase().split(";")[0]?.trim() ?? "";

  const isPdf = extension === "pdf" || mime === "application/pdf";
  const isDocx =
    extension === "docx" ||
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const isText =
    ["txt", "md", "markdown", "csv"].includes(extension) ||
    ["text/plain", "text/markdown", "text/csv"].includes(mime);

  if (!isPdf && !isDocx && !isText) {
    throw new AppError(
      `Unsupported file type: ${extension || mime}`,
      415,
      "errors.unsupportedFileType",
      { type: extension || mime },
    );
  }

  let text: string;

  if (isPdf) {
    const proxy = await getDocumentProxy(file.bytes);
    const result = await unpdfExtractText(proxy, { mergePages: true });
    // unpdf returns { text: string } or { text: string[] } depending on mergePages
    const raw = Array.isArray(result.text)
      ? result.text.join("\n")
      : result.text;
    text = normalize(raw);
    if (!text) {
      throw new AppError(
        "No extractable text found in PDF",
        422,
        "errors.noExtractableText",
        { kind: "PDF" },
      );
    }
  } else if (isDocx) {
    const result = await mammoth.extractRawText({
      buffer: Buffer.from(file.bytes),
    });
    text = normalize(result.value);
    if (!text) {
      throw new AppError(
        "No extractable text found in DOCX",
        422,
        "errors.noExtractableText",
        { kind: "DOCX" },
      );
    }
  } else {
    text = normalize(new TextDecoder("utf-8").decode(file.bytes));
  }

  if (text.length > TEXT_CAP) {
    throw new AppError(
      "Document text exceeds the 2 MB character limit",
      413,
      "errors.documentTooLarge",
    );
  }

  return { text };
}
