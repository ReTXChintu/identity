import nodemailer from "nodemailer";
import type { AppConfig } from "../config.js";
import { TOKENS as T } from "../views/theme.js";

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
// from the same design tokens as the web pages (views/theme.ts).
function wrap(inner: string): string {
  return `<!doctype html><html><body style="margin:0;padding:${T["space-6"]};font-family:${escape(T["font-sans"])};color:${T["color-text"]};background:${T["color-bg"]}">
<div style="background:${T["color-surface"]};border-radius:${T["radius-lg"]};padding:${T["space-6"]}">${inner}
<p style="color:${T["color-text-muted"]};font-size:${T["font-size-sm"]};margin-top:${T["space-6"]}">One account for SpendLog, Trippin and InFrame.</p></div></body></html>`;
}

export function verificationEmail(to: string, name: string, code: string): Mail {
  return {
    to,
    subject: `${code} is your verification code`,
    text: `Hi ${name},\n\nYour verification code is ${code}\n\nIt works for 15 minutes. If you didn't create an account, ignore this email.\n`,
    html: wrap(`<p>Hi ${escape(name)},</p><p>Your verification code is</p>
<p style="font-size:${T["font-size-3xl"]};font-weight:${T["font-weight-bold"]};letter-spacing:${T["space-2"]};margin:${T["space-2"]} 0">${code}</p>
<p>It works for 15 minutes. If you didn't create an account, ignore this email.</p>`),
  };
}

export function resetEmail(to: string, name: string, link: string): Mail {
  return {
    to,
    subject: "Reset your password",
    text: `Hi ${name},\n\nSet a new password here (the link works for one hour):\n${link}\n\nIf you didn't ask for this, ignore this email; your password stays the same.\n`,
    html: wrap(`<p>Hi ${escape(name)},</p><p>Set a new password using the button below. The link works for one hour.</p>
<p><a href="${escape(link)}" style="display:inline-block;background:${T["color-accent"]};color:${T["color-on-accent"]};text-decoration:none;padding:${T["space-3"]} ${T["space-5"]};border-radius:${T["radius-sm"]};font-weight:${T["font-weight-semibold"]}">Set a new password</a></p>
<p style="font-size:${T["font-size-sm"]};color:${T["color-text-muted"]};word-break:break-all">${escape(link)}</p>
<p>If you didn't ask for this, ignore this email; your password stays the same.</p>`),
  };
}
