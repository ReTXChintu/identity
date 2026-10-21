// The shared HTML shell: inline CSS (nonce'd for the strict CSP), light and
// dark themes, full-width and mobile-first. These pages often open inside an
// Android Chrome Custom Tab, so they carry no external assets at all.
import { escapeHtml as e } from "../security.js";
import type { Branding } from "../oidc/clients.js";
import { STYLESHEET } from "./theme.js";


const SCRIPT = `
document.querySelectorAll("[data-toggle]").forEach(function (button) {
  button.addEventListener("click", function () {
    var input = document.getElementById(button.getAttribute("data-toggle"));
    if (!input) return;
    var show = input.type === "password";
    input.type = show ? "text" : "password";
    button.setAttribute("aria-label", show ? "Hide password" : "Show password");
    button.setAttribute("aria-pressed", show ? "true" : "false");
    button.classList.toggle("on", show);
  });
});
document.querySelectorAll("form[data-once]").forEach(function (form) {
  form.addEventListener("submit", function () {
    form.querySelectorAll("button[type=submit]").forEach(function (b) { setTimeout(function () { b.disabled = true; }, 0); });
  });
});
var auto = document.querySelector("form[data-autosubmit]");
if (auto) auto.submit();
`;

export interface LayoutOptions {
  title: string;
  nonce: string;
  body: string;
  /** Show the account link in the top bar (off on sign-in pages). */
  accountLink?: boolean;
}

export function layout({ title, nonce, body, accountLink }: LayoutOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${e(title)}</title>
<style nonce="${e(nonce)}">${STYLESHEET}</style>
</head>
<body>
<header class="topbar">
  <span class="dots" aria-hidden="true"><span class="dot spendlog"></span><span class="dot trippin"></span><span class="dot inframe"></span></span>
  <span class="brand">Account</span>
  <span class="spacer"></span>
  ${accountLink ? '<a href="/account">Your account</a>' : ""}
</header>
<main>
${body}
</main>
<footer>One account for SpendLog, Trippin and InFrame.</footer>
<script nonce="${e(nonce)}">${SCRIPT}</script>
</body>
</html>`;
}

const EYE = `<svg class="on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><svg class="off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

/** A password input with its show/hide eye button. Every password field uses this. */
export function passwordField(opts: {
  id: string;
  name: string;
  label: string;
  autocomplete: "current-password" | "new-password";
  hint?: string;
  minlength?: number;
}): string {
  return `<label for="${e(opts.id)}">${e(opts.label)}</label>
<div class="pw">
  <input class="input" type="password" id="${e(opts.id)}" name="${e(opts.name)}" autocomplete="${opts.autocomplete}" required${
    opts.minlength ? ` minlength="${opts.minlength}"` : ""
  } maxlength="200">
  <button type="button" class="eye" data-toggle="${e(opts.id)}" aria-label="Show password" aria-pressed="false">${EYE}</button>
</div>${opts.hint ? `<p class="hint">${e(opts.hint)}</p>` : ""}`;
}

export function alerts(opts: { error?: string; notice?: string }): string {
  return `${opts.error ? `<div class="alert error" role="alert">${e(opts.error)}</div>` : ""}${
    opts.notice ? `<div class="alert ok" role="status">${e(opts.notice)}</div>` : ""
  }`;
}

export function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${e(name)}" value="${e(value)}">`;
}

export const GOOGLE_ICON = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.5z"/></svg>`;

/** The left-hand panel on sign-in pages: what this is, and who is asking. */
export function hero(branding: Branding | null): string {
  const asking = branding
    ? `<div class="asking ${branding.className}"><span class="mono">${e(branding.monogram)}</span><div><strong>${
        branding.className === "app-account" ? "Signing in to your account" : `Continue to ${e(branding.name)}`
      }</strong><span>${
        branding.className === "app-account"
          ? "Manage your name, password and Google sign-in."
          : `${e(branding.name)} is asking you to sign in.`
      }</span></div></div>`
    : "";
  return `<section class="hero">
  <h1>One account for SpendLog, Trippin and InFrame</h1>
  <p>Sign in once and every app knows it's you, on the web and on Android.</p>
  <div class="apps">
    <span class="chip app-spendlog"><span class="mono">S</span>SpendLog</span>
    <span class="chip app-trippin"><span class="mono">T</span>Trippin</span>
    <span class="chip app-inframe"><span class="mono">I</span>InFrame</span>
  </div>
  ${asking}
</section>`;
}
