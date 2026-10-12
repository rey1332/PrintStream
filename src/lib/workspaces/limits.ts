export const MAX_ERPS_PER_ACCOUNT = 3;

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const MAX_WORKSPACE_DOCUMENT_BYTES = 1024 * 1024 * 1024;

export const DOCUMENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  txt: 'text/plain',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
};

export const DOCUMENT_ACCEPT = Object.keys(DOCUMENT_TYPES)
  .map((ext) => `.${ext}`)
  .join(',');

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

export function cleanDocumentName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const unsafe = /[\u0000-\u001f\u007f"<>|:*?]/g;
  const cleaned = base.replace(unsafe, '_').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 200) return cleaned;
  const ext = extensionOf(cleaned);
  const keep = ext ? 200 - ext.length - 1 : 200;
  return ext ? `${cleaned.slice(0, keep)}.${ext}` : cleaned.slice(0, 200);
}
