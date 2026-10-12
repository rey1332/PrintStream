// ETNA's outgoing e-mail, configured with environment variables:
//
//   SMTP_HOST       mail server (e.g. smtp.gmail.com)
//   SMTP_PORT       587 (STARTTLS, default) or 465 (TLS)
//   SMTP_SECURE     true for port 465
//   SMTP_USER       account name, usually the address
//   SMTP_PASSWORD   password or app password
//   SMTP_FROM       sender, e.g. "ETNA <erp@example.co.id>" (default SMTP_USER)
//
// Without SMTP_HOST e-mail is off and the admin panel shows links to copy.

import { mailAddress, sendSmtp, type MailMessage } from './smtp';

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

export function mailConfig(
  env: Record<string, string | undefined> = process.env
): MailConfig | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;
  const secure = env.SMTP_SECURE?.trim().toLowerCase() === 'true';
  const port = Number(env.SMTP_PORT || (secure ? 465 : 587));
  const user = env.SMTP_USER?.trim() ?? '';
  const from = env.SMTP_FROM?.trim() || user;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !mailAddress(from)) return null;
  return { host, port, secure, user, password: env.SMTP_PASSWORD ?? '', from };
}

export const mailConfigured = () => mailConfig() !== null;

/** The sender address shown in the panel (never the password). */
export const mailSender = () => {
  const config = mailConfig();
  return config ? mailAddress(config.from) : null;
};

export async function sendMail(
  message: Omit<MailMessage, 'from'>
): Promise<{ ok: true } | { ok: false; error: string }> {
  const config = mailConfig();
  if (!config) return { ok: false, error: 'not_configured' };
  try {
    await sendSmtp(
      {
        host: config.host,
        port: config.port,
        secure: config.secure,
        user: config.user || undefined,
        password: config.password,
      },
      { ...message, from: config.from }
    );
    return { ok: true };
  } catch (error) {
    // The reason only (refused, timeout, no TLS); no addresses or credentials.
    const reason = error instanceof Error ? error.message.slice(0, 120) : 'failed';
    console.error('[mail] not sent:', reason);
    return { ok: false, error: reason };
  }
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

export type LinkMailKind = 'invite' | 'reset' | 'company';

/**
 * The e-mail with a password link, in Indonesian and English. `company` is
 * the new ERP's name for a company owner's invitation.
 */
export function linkMail(
  kind: LinkMailKind,
  url: string,
  expiresAt: string,
  company?: string
): { subject: string; text: string; html: string } {
  const expires = new Date(expiresAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const forCompany = company ? ` ${company}` : '';
  const id =
    kind === 'reset'
      ? ['Atur ulang kata sandi PrintStream Anda', 'Buka tautan ini untuk membuat kata sandi baru:']
      : [
          `Akun PrintStream${forCompany} Anda sudah siap`,
          'Buka tautan ini untuk membuat kata sandi dan masuk:',
        ];
  const en =
    kind === 'reset'
      ? ['Reset your PrintStream password', 'Open this link to choose a new password:']
      : [
          `Your PrintStream account${forCompany} is ready`,
          'Open this link to choose a password and sign in:',
        ];
  const subject = `${id[0]} / ${en[0]}`;
  const text = [
    id[0],
    '',
    id[1],
    url,
    `Tautan berlaku sampai ${expires} WIB dan hanya dapat dipakai sekali.`,
    '',
    '---',
    '',
    en[0],
    '',
    en[1],
    url,
    `The link works until ${expires} (Jakarta time) and only once.`,
    '',
    'Jika Anda tidak mengharapkan e-mail ini, abaikan saja. / If you did not expect this e-mail, ignore it.',
  ].join('\n');
  const link = `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">
<h2 style="font-size:16px">${escapeHtml(id[0])}</h2><p>${escapeHtml(id[1])}</p>${link}
<p>Tautan berlaku sampai ${escapeHtml(expires)} WIB dan hanya dapat dipakai sekali.</p><hr>
<h2 style="font-size:16px">${escapeHtml(en[0])}</h2><p>${escapeHtml(en[1])}</p>${link}
<p>The link works until ${escapeHtml(expires)} (Jakarta time) and only once.</p>
<p style="color:#666">Jika Anda tidak mengharapkan e-mail ini, abaikan saja. / If you did not expect this e-mail, ignore it.</p></div>`;
  return { subject, text, html };
}

/**
 * An invitation to a workspace, in Indonesian and English: the access code,
 * and for a new account the link to choose a password first.
 */
export function workspaceInviteMail(invite: {
  workspace: string;
  inviter: string;
  code: string;
  joinUrl: string;
  expiresAt: string;
  passwordUrl?: string;
  passwordExpiresAt?: string;
}): { subject: string; text: string; html: string } {
  const when = (value: string) =>
    new Date(value).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const expires = when(invite.expiresAt);
  const subject = `Undangan ke ${invite.workspace} di PrintStream / Invitation to ${invite.workspace} on PrintStream`;
  const idLines = [
    `${invite.inviter} mengundang Anda ke ${invite.workspace} di PrintStream (ETNA).`,
    ...(invite.passwordUrl
      ? [
          'Akun Anda sudah dibuat. Buat kata sandi dulu lewat tautan ini (sekali pakai):',
          invite.passwordUrl,
        ]
      : []),
    'Setelah masuk, buka tautan ini atau masukkan kode akses di Ruang kerja → Gabung:',
    invite.joinUrl,
    `Kode akses: ${invite.code}`,
    `Kode berlaku sampai ${expires} WIB dan hanya dapat dipakai sekali.`,
  ];
  const enLines = [
    `${invite.inviter} invited you to ${invite.workspace} on PrintStream (ETNA).`,
    ...(invite.passwordUrl
      ? [
          'Your account has been created. First choose a password with this one-time link:',
          invite.passwordUrl,
        ]
      : []),
    'After signing in, open this link or enter the access code under Workspace → Join:',
    invite.joinUrl,
    `Access code: ${invite.code}`,
    `The code works until ${expires} (Jakarta time) and only once.`,
  ];
  const footer =
    'Jika Anda tidak mengharapkan e-mail ini, abaikan saja. / If you did not expect this e-mail, ignore it.';
  const text = [...idLines, '', '---', '', ...enLines, '', footer].join('\n');
  const para = (line: string) =>
    /^https?:\/\//.test(line)
      ? `<p><a href="${escapeHtml(line)}">${escapeHtml(line)}</a></p>`
      : `<p>${escapeHtml(line)}</p>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">
${idLines.map(para).join('\n')}<hr>
${enLines.map(para).join('\n')}
<p style="color:#666">${escapeHtml(footer)}</p></div>`;
  return { subject, text, html };
}

/** A short notice in Indonesian and English (staff access, termination). */
export function noticeMail(
  subject: { id: string; en: string },
  lines: { id: string[]; en: string[] }
): { subject: string; text: string; html: string } {
  const footer = 'PrintStream · ETNA';
  const text = [...lines.id, '', '---', '', ...lines.en, '', footer].join('\n');
  const para = (line: string) => `<p>${escapeHtml(line)}</p>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">
${lines.id.map(para).join('\n')}<hr>
${lines.en.map(para).join('\n')}
<p style="color:#666">${footer}</p></div>`;
  return { subject: `${subject.id} / ${subject.en}`, text, html };
}
