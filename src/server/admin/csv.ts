// CSV for admin exports: RFC 4180 quoting, a UTF-8 BOM so Excel reads
// Indonesian and Chinese text, and cells that a spreadsheet would run as a
// formula (=, +, -, @, tab, carriage return) prefixed with a quote.

export type CsvValue = string | number | boolean | null | undefined | Date | object;

function cell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  return '﻿' + [headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
