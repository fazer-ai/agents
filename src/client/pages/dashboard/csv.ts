// A block's figures as a CSV file, exactly the rows and values the block shows. Numbers are written
// raw (a dot decimal, no thousands separator, no currency sign) so a spreadsheet reads them as
// numbers in any locale; a cell with a comma, a quote or a line break is quoted. A TEXT cell that
// starts like a formula (=, +, -, @, tab, carriage return) is written behind an apostrophe: agent,
// inbox and label names come from outside, and a spreadsheet would evaluate them otherwise.

export type CsvCell = string | number | null | undefined;

function cell(v: CsvCell): string {
  if (v === null || v === undefined) return "";
  const s =
    typeof v === "number"
      ? Number.isFinite(v)
        ? String(v)
        : ""
      : /^[=+\-@\t\r]/.test(v)
        ? `'${v}`
        : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

export function downloadCsv(
  filename: string,
  header: string[],
  rows: CsvCell[][],
): void {
  // The BOM makes Excel read the file as UTF-8, so accented labels survive.
  const blob = new Blob([`﻿${toCsv(header, rows)}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
