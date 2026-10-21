// The shared HTML shells, built on the suite design system (theme.ts).
//
// - authLayout: the sign-in layout (design system §6.2): a brand panel and the
//   form panel side by side on desktop, stacked on phones, full width.
// - pageLayout: the account page shell (§6.1): a header bar and a full-width
//   main area.
//
// Styles and the script are inline with this request's CSP nonce. The only
// external asset is the IBM Plex stylesheet from Google Fonts, which the CSP
// allows by origin (security.ts). These pages often open inside an Android
// Chrome Custom Tab, so there is nothing else to fetch.
import { escapeHtml as e } from "../security.js";
import type { Branding } from "../oidc/clients.js";
import { icon, mark, markFor } from "./icons.js";
import { accentClass, FONT_CSS_ORIGIN, FONT_FILE_ORIGIN, FONT_STYLESHEET_URL, STYLESHEET } from "./theme.js";

// The password eye (design system §7.2): swaps the input type, the label and
// the pressed state; a revealed value is set in Plex Mono.
const SCRIPT = `
document.querySelectorAll("[data-toggle]").forEach(function (button) {
  button.addEventListener("click", function () {
    var input = document.getElementById(button.getAttribute("data-toggle"));
    if (!input) return;
    var show = input.type === "password";
    input.type = show ? "text" : "password";
    input.classList.toggle("is-revealed", show);
    button.setAttribute("aria-label", show ? "Hide password" : "Show password");
    button.setAttribute("aria-pressed", show ? "true" : "false");
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

function documentShell(o: { title: string; nonce: string; accent?: string; body: string }): string {
  const cls = accentClass(o.accent);
  return `<!doctype html>
<html lang="en"${cls ? ` class="${cls}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${e(o.title)}</title>
<link rel="preconnect" href="${FONT_CSS_ORIGIN}">
<link rel="preconnect" href="${FONT_FILE_ORIGIN}" crossorigin>
<link rel="stylesheet" href="${FONT_STYLESHEET_URL}">
<style nonce="${e(o.nonce)}">${STYLESHEET}</style>
</head>
<body>
${o.body}
<script nonce="${e(o.nonce)}">${SCRIPT}</script>
</body>
</html>`;
}

const APPS: { className: string; name: string }[] = [
  { className: "app-spendlog", name: "SpendLog" },
  { className: "app-trippin", name: "Trippin" },
  { className: "app-inframe", name: "InFrame" },
];

const BENEFITS: { icon: Parameters<typeof icon>[0]; text: string }[] = [
  { icon: "lock", text: "Your password is kept only as a one-way hash" },
  { icon: "refresh", text: "Change your password once and it changes in every app" },
  { icon: "shield", text: "Sign out of every app on every device in one step" },
];

/** The brand panel's lower card: who is asking, and the apps this account opens. */
function glimpse(branding: Branding | null): string {
  const isAccount = branding?.className === "app-account";
  const head = !branding
    ? `<p class="t-title-card">Works in all three apps</p><p class="t-body-s tx3">Sign in to one and the others know it’s you.</p>`
    : isAccount
      ? `<p class="t-title-card">Signing in to your account</p><p class="t-body-s tx3">Manage your name, password and Google sign-in.</p>`
      : `<p class="t-title-card">Continue to ${e(branding.name)}</p><p class="t-body-s tx3">${e(branding.name)} is asking you to sign in.</p>`;
  const rows = APPS.map((app) => {
    const asking = branding?.className === app.className;
    return `<li class="app-row ${app.className}${asking ? " app-row--asking" : ""}">${mark(markFor(app.className))}<span class="app-row__name">${e(
      app.name,
    )}</span>${asking ? '<span class="badge badge--on">Asking you to sign in</span>' : ""}</li>`;
  }).join("");
  return `<div class="glimpse"><div class="glimpse__head">${head}</div><ul class="apps" aria-label="Apps that use this account">${rows}</ul></div>`;
}

/** The brand panel (design system §6.2): logo, headline, benefits, glimpse. */
function brandPanel(branding: Branding | null, accountLink: boolean): string {
  const app = accentClass(branding?.className) ? branding : null;
  return `<section class="auth__brand" aria-label="About this account">
  <div class="brand__top">
    <span class="logo">${mark(markFor(app?.className))}<span>${app ? e(app.name) : "Account"}</span></span>
    <span class="spacer"></span>
    ${accountLink ? '<a class="brand__link" href="/account">Your account</a>' : ""}
  </div>
  <div class="brand__copy">
    <p class="t-display">One account for SpendLog, Trippin and InFrame</p>
    <p class="t-body-l brand__lede">Sign in once and every app knows it’s you, on the web and on Android.</p>
  </div>
  <ul class="benefits">${BENEFITS.map(
    (b) => `<li class="benefit"><span class="icon-tile icon-tile--sm">${icon(b.icon)}</span><span>${e(b.text)}</span></li>`,
  ).join("")}</ul>
  ${glimpse(branding)}
</section>`;
}

export interface AuthLayoutOptions {
  title: string;
  nonce: string;
  /** Who is asking. An app's branding also gives the page that app's accent. */
  branding: Branding | null;
  /** The form column: one or more cards. */
  content: string;
  /** Show the "Your account" link in the brand panel. */
  accountLink?: boolean;
}

export function authLayout(o: AuthLayoutOptions): string {
  return documentShell({
    title: o.title,
    nonce: o.nonce,
    accent: o.branding?.className,
    body: `<div class="auth">
${brandPanel(o.branding, Boolean(o.accountLink))}
<main class="auth__form"><div class="auth__col">
${o.content}
</div></main>
</div>`,
  });
}

/** The account page shell: header bar plus a full-width main area. */
export function pageLayout(o: { title: string; nonce: string; body: string }): string {
  return documentShell({
    title: o.title,
    nonce: o.nonce,
    body: `<div class="page">
<header class="topbar">
  <a class="logo" href="/account">${mark("identity")}<span>Account</span></a>
  <span class="spacer"></span>
  <a class="btn btn--ghost btn--sm" href="/account/signout">Sign out</a>
</header>
<main class="main">
${o.body}
</main>
</div>`,
  });
}

/** A password input with its show/hide eye button. Every password field uses this. */
export function passwordField(opts: {
  id: string;
  name: string;
  label: string;
  autocomplete: "current-password" | "new-password";
  hint?: string;
  minlength?: number;
}): string {
  const id = e(opts.id);
  const hintId = opts.hint ? `${id}-help` : "";
  return `<div class="field">
  <label class="label" for="${id}">${e(opts.label)}</label>
  <div class="pw">
    <input class="input" type="password" id="${id}" name="${e(opts.name)}" autocomplete="${opts.autocomplete}" required${
      opts.minlength ? ` minlength="${opts.minlength}"` : ""
    } maxlength="200"${hintId ? ` aria-describedby="${hintId}"` : ""}>
    <button type="button" class="eye" data-toggle="${id}" aria-controls="${id}" aria-label="Show password" aria-pressed="false">${icon(
      "eye",
      20,
      "i-on",
    )}${icon("eye-off", 20, "i-off")}</button>
  </div>${opts.hint ? `\n  <p class="help" id="${hintId}">${e(opts.hint)}</p>` : ""}
</div>`;
}

/** A labelled text-like input (design system §7.2). `attrs` is trusted markup. */
export function textField(opts: { id: string; name: string; label: string; type: string; attrs: string; value?: string; inputClass?: string }): string {
  const id = e(opts.id);
  return `<div class="field">
  <label class="label" for="${id}">${e(opts.label)}</label>
  <input class="input${opts.inputClass ? ` ${opts.inputClass}` : ""}" type="${opts.type}" id="${id}" name="${e(opts.name)}" ${opts.attrs}${
    opts.value !== undefined ? ` value="${e(opts.value)}"` : ""
  }>
</div>`;
}

/** Inline banners (design system §7.11): an error, or a confirmation. */
export function alerts(opts: { error?: string; notice?: string }): string {
  return `${
    opts.error ? `<div class="banner banner--crit" role="alert">${icon("alert-triangle")}<span>${e(opts.error)}</span></div>` : ""
  }${opts.notice ? `<div class="banner banner--good" role="status">${icon("check")}<span>${e(opts.notice)}</span></div>` : ""}`;
}

export function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${e(name)}" value="${e(value)}">`;
}

/**
 * The Google button (design system §7.1), with a leading "G" disc. Secondary,
 * not primary: it sits on the same card as "Sign in", and one card gets one
 * primary action.
 */
export function googleButton(href: string, label = "Continue with Google", size: "lg" | "md" = "lg"): string {
  return `<a class="btn btn--secondary${size === "lg" ? " btn--lg btn--block" : ""}" href="${e(href)}"><span class="g" aria-hidden="true">G</span><span>${e(
    label,
  )}</span></a>`;
}
