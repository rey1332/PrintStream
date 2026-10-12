// A small SMTP client: one message to one recipient over TLS (implicit TLS
// on port 465, or STARTTLS), with AUTH PLAIN or LOGIN. Enough for ETNA's
// own e-mail (invitations, password links, tests) without a dependency.

import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export interface SmtpOptions {
  host: string;
  port: number;
  /** TLS from the first byte (port 465); otherwise STARTTLS is required. */
  secure: boolean;
  user?: string;
  password?: string;
  /** Only for tests and local relays: allow a connection without TLS. */
  allowInsecure?: boolean;
  /** Extra trusted certificate (PEM), e.g. a private relay's; tests use a self-signed one. */
  ca?: string;
  timeoutMs?: number;
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const ADDRESS = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

/** The bare address of "Name <a@b.c>" or "a@b.c", or null. */
export function mailAddress(value: string): string | null {
  const match = /<([^<>]+)>\s*$/.exec(value.trim());
  const address = (match ? match[1] : value).trim();
  return ADDRESS.test(address) && address.length <= 254 ? address : null;
}

/** A header value: no line breaks; non-ASCII as an RFC 2047 encoded word. */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

const base64Lines = (text: string) =>
  (
    Buffer.from(text, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g) ?? []
  ).join('\r\n');

/** The whole message (headers and a base64 UTF-8 body), CRLF line ends. */
export function buildMessage(message: MailMessage, now = new Date()): string {
  const fromAddress = mailAddress(message.from);
  const domain = fromAddress?.split('@')[1] ?? 'localhost';
  const fromName = /^(.*?)\s*<[^<>]+>\s*$/.exec(message.from.trim())?.[1]?.replace(/^"|"$/g, '');
  const from = fromName ? `${encodeHeader(fromName)} <${fromAddress}>` : `${fromAddress}`;
  const headers = [
    `From: ${from}`,
    `To: <${mailAddress(message.to)}>`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
  ];
  if (!message.html) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(message.text),
      '',
    ].join('\r\n');
  }
  const boundary = `etna-${randomUUID()}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(message.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

class Conversation {
  private buffer = '';
  private waiting: ((reply: { code: number; text: string }) => void) | null = null;
  private failure: ((error: Error) => void) | null = null;

  socket: net.Socket;
  private timeoutMs: number;

  constructor(socket: net.Socket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.listen(socket);
  }

  private onData = (chunk: Buffer | string) => {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.flush();
  };
  private onError = (error: Error) => this.failure?.(error);
  private onClose = () => this.failure?.(new Error('connection closed'));

  listen(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  /** Before STARTTLS: the TLS socket takes over the plain one. */
  detach() {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
  }

  private flush() {
    // A reply ends with a line "NNN text" (a space after the code).
    const lines = this.buffer.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        const replyLines = lines.slice(0, i + 1);
        this.buffer = lines.slice(i + 1).join('\r\n');
        const resolve = this.waiting;
        this.waiting = null;
        this.failure = null;
        resolve?.({ code: Number(lines[i].slice(0, 3)), text: replyLines.join('\n') });
        return;
      }
    }
  }

  read(): Promise<{ code: number; text: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), this.timeoutMs);
      this.waiting = (reply) => {
        clearTimeout(timer);
        resolve(reply);
      };
      this.failure = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.flush();
    });
  }

  async command(line: string, expect: number[]): Promise<string> {
    this.socket.write(`${line}\r\n`);
    const reply = await this.read();
    if (!expect.includes(reply.code)) {
      // Never echo credentials: AUTH lines are reported by their verb only.
      const verb = line.startsWith('AUTH') ? 'AUTH' : line.split(' ')[0];
      throw new Error(`${verb} refused (${reply.code})`);
    }
    return reply.text;
  }
}

function connect(options: SmtpOptions): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = options.secure
      ? tls.connect({
          host: options.host,
          port: options.port,
          servername: options.host,
          ca: options.ca,
        })
      : net.connect({ host: options.host, port: options.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout'));
    }, options.timeoutMs ?? 20_000);
    socket.once(options.secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function upgrade(socket: net.Socket, host: string, ca?: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host, ca });
    secure.once('secureConnect', () => resolve(secure));
    secure.once('error', reject);
  });
}

/** Sends one message. Throws on any refusal; the error never contains credentials. */
export async function sendSmtp(options: SmtpOptions, message: MailMessage): Promise<void> {
  const from = mailAddress(message.from);
  const to = mailAddress(message.to);
  if (!from || !to) throw new Error('invalid address');
  const socket = await connect(options);
  const talk = new Conversation(socket, options.timeoutMs ?? 20_000);
  const hostname = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  try {
    const greeting = await talk.read();
    if (greeting.code !== 220) throw new Error(`greeting refused (${greeting.code})`);
    let ehlo = await talk.command(`EHLO ${hostname}`, [250]);
    if (!options.secure) {
      if (/\bSTARTTLS\b/i.test(ehlo)) {
        await talk.command('STARTTLS', [220]);
        talk.detach();
        talk.listen(await upgrade(talk.socket, options.host, options.ca));
        ehlo = await talk.command(`EHLO ${hostname}`, [250]);
      } else if (!options.allowInsecure) {
        throw new Error('the server does not offer TLS');
      }
    }
    if (options.user) {
      if (/AUTH[^\n]*\bPLAIN\b/i.test(ehlo)) {
        const token = Buffer.from(`\u0000${options.user}\u0000${options.password ?? ''}`).toString(
          'base64'
        );
        await talk.command(`AUTH PLAIN ${token}`, [235]);
      } else {
        await talk.command('AUTH LOGIN', [334]);
        await talk.command(Buffer.from(options.user).toString('base64'), [334]);
        await talk.command(Buffer.from(options.password ?? '').toString('base64'), [235]);
      }
    }
    await talk.command(`MAIL FROM:<${from}>`, [250]);
    await talk.command(`RCPT TO:<${to}>`, [250, 251]);
    await talk.command('DATA', [354]);
    // Dot-stuffing: a line starting with "." gets a second one.
    const body = buildMessage(message).replace(/\r\n\./g, '\r\n..');
    await talk.command(`${body}\r\n.`, [250]);
    await talk.command('QUIT', [221]).catch(() => undefined);
  } finally {
    talk.socket.destroy();
  }
}
