import nodemailer from "nodemailer";
import type { AppConfig } from "../config.js";
import { FONT_MONO, FONT_SANS, FONT_STYLESHEET_URL, LIGHT as C } from "../views/theme.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** SMTP via nodemailer, or the console when SMTP isn't configured. */
export function createMailer(config: AppConfig): Mailer {
  if (!config.smtp) {
    return {
      async send(mail) {
        console.log(
          `\n--- email (SMTP not configured) ---\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n----------------------------------\n`,
        );
      },
    };
  }

  const { host, port, secure, user, pass } = config.smtp;
  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
  });

  return {
    async send(mail) {
      await transport.sendMail({ from: config.mailFrom, ...mail });
    },
  };
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Email clients ignore <style> blocks, so emails use inline styles, built
// from the same design tokens as the web pages (views/theme.ts): the light
// theme and Identity's neutral ink accent. Full width, like the pages: no
// centred column, just side padding.
const font = escape(FONT_SANS);
const mono = escape(FONT_MONO);
const text = `font-family:${font};font-size:15px;line-height:22px;color:${C.tx2};margin:0 0 16px`;

function wrap(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><link rel="stylesheet" href="${FONT_STYLESHEET_URL}"><title>${escape(title)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg}"><tr><td style="padding:24px 16px">
<p style="font-family:${font};font-size:18px;line-height:24px;font-weight:700;letter-spacing:-.01em;color:${C.tx};margin:0 0 16px">Account</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.sf};border:1px solid ${C.ln};border-radius:14px"><tr><td style="padding:24px">
<h1 style="font-family:${font};font-size:22px;line-height:28px;font-weight:600;color:${C.tx};margin:0 0 16px">${escape(title)}</h1>
${inner}
</td></tr></table>
<p style="font-family:${font};font-size:12px;line-height:17px;color:${C.tx3};margin:16px 0 0">One account for SpendLog, Trippin and InFrame.</p>
</td></tr></table></body></html>`;
}

export function verificationEmail(to: string, name: string, code: string): Mail {
  return {
    to,
    subject: `${code} is your verification code`,
    text: `Hi ${name},\n\nYour verification code is ${code}\n\nIt works for 15 minutes. If you didn't create an account, ignore this email.\n`,
    html: wrap(
      "Your verification code",
      `<p style="${text}">Hi ${escape(name)}, your verification code is</p>
<p style="font-family:${mono};font-size:34px;line-height:40px;font-weight:500;letter-spacing:.12em;color:${C.tx};background:${C.sf2};border:1px solid ${C.ln};border-radius:12px;padding:16px 20px;margin:0 0 16px;display:inline-block">${escape(code)}</p>
<p style="${text};margin:0">It works for 15 minutes. If you didn’t create an account, ignore this email.</p>`,
    ),
  };
}

export function resetEmail(to: string, name: string, link: string): Mail {
  return {
    to,
    subject: "Reset your password",
    text: `Hi ${name},\n\nSet a new password here (the link works for one hour):\n${link}\n\nIf you didn't ask for this, ignore this email; your password stays the same.\n`,
    html: wrap(
      "Reset your password",
      `<p style="${text}">Hi ${escape(name)}, set a new password using the button below. The link works for one hour.</p>
<p style="margin:0 0 16px"><a href="${escape(link)}" style="display:inline-block;font-family:${font};font-size:15px;line-height:20px;font-weight:600;background:${C.ac};color:${C["ac-tx"]};text-decoration:none;padding:14px 24px;border-radius:12px">Set a new password</a></p>
<p style="font-family:${font};font-size:12px;line-height:17px;color:${C.tx3};word-break:break-all;margin:0 0 16px">Or open this link: <a href="${escape(link)}" style="color:${C.ac}">${escape(link)}</a></p>
<p style="${text};margin:0">If you didn’t ask for this, ignore this email; your password stays the same.</p>`,
    ),
  };
}
