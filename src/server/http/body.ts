import { NextRequest } from 'next/server';

export class BodyTooLargeError extends Error {
  constructor() {
    super('Request is too large');
  }
}

export const MAX_JSON_BODY = 1024 * 1024;

export async function readLimitedBytes(request: Request, max: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new BodyTooLargeError();
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readLimitedText(request: Request, max: number): Promise<string> {
  return new TextDecoder().decode(await readLimitedBytes(request, max));
}

export async function withLimitedBody(request: NextRequest, max: number): Promise<NextRequest> {
  const bytes = await readLimitedBytes(request, max);
  return new NextRequest(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes.byteLength > 0 ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : undefined,
  });
}
