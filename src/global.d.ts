declare module "*.css";

// The PDF engine under @react-pdf/renderer ships no types. The header measures words with it, in the
// same built-in fonts the page is drawn in.
declare module "pdfkit" {
  export default class PDFDocument {
    constructor(options?: { autoFirstPage?: boolean });
    font(name: string): this;
    fontSize(size: number): this;
    widthOfString(text: string): number;
  }
}
