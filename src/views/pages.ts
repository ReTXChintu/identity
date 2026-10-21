import { escapeHtml as e } from "../security.js";
import type { Branding } from "../oidc/clients.js";
import { MIN_PASSWORD_LENGTH } from "../services/passwords.js";
import { icon, type IconName, mark, markFor } from "./icons.js";
import { alerts, authLayout, googleButton, hidden, pageLayout, passwordField, textField } from "./layout.js";

interface Base {
  nonce: string;
  error?: string;
  notice?: string;
}

interface InteractionBase extends Base {
  uid: string;
  csrf: string;
  branding: Branding | null;
}

/** The sign-in card (design system §6.2): title 22/28, lede 15/22, then the rest. */
function authCard(title: string, lede: string, inner: string): string {
  return `<section class="card card--auth" aria-labelledby="page-title">
<div class="intro"><h1 class="t-title-page" id="page-title">${title}</h1>${lede ? `<p class="t-body-l tx2">${lede}</p>` : ""}</div>
${inner}
</section>`;
}

const submit = (label: string) => `<button class="btn btn--primary btn--lg btn--block" type="submit">${e(label)}</button>`;

const emailField = (o: { autocomplete: string; value?: string; autofocus?: boolean }) =>
  textField({
    id: "email",
    name: "email",
    label: "Email",
    type: "email",
    attrs: `autocomplete="${o.autocomplete}" required maxlength="254"${o.autofocus ? " autofocus" : ""}`,
    value: o.value ?? "",
  });

export function loginPage(o: InteractionBase & { email?: string; googleEnabled: boolean }): string {
  const base = `/interaction/${encodeURIComponent(o.uid)}`;
  return authLayout({
    title: "Sign in",
    nonce: o.nonce,
    branding: o.branding,
    content: authCard(
      `Sign in${o.branding ? ` to ${e(o.branding.name)}` : ""}`,
      "Use your SpendLog, Trippin or InFrame account.",
      `${alerts(o)}
${o.googleEnabled ? `${googleButton(`${base}/google`)}<div class="or">or with email</div>` : ""}
<form class="stack" method="post" action="${base}/login" data-once>
  ${hidden("csrf", o.csrf)}
  ${emailField({ autocomplete: "username", value: o.email, autofocus: !o.email })}
  ${passwordField({ id: "password", name: "password", label: "Password", autocomplete: "current-password" })}
  ${submit("Sign in")}
</form>
<div class="links">
  <a href="${base}/signup">Create account</a>
  <a href="${base}/forgot">Forgot password?</a>
</div>`,
    ),
  });
}

export function signupPage(o: InteractionBase & { email?: string; name?: string; googleEnabled: boolean }): string {
  const base = `/interaction/${encodeURIComponent(o.uid)}`;
  return authLayout({
    title: "Create account",
    nonce: o.nonce,
    branding: o.branding,
    content: authCard(
      "Create your account",
      "One account works in all three apps.",
      `${alerts(o)}
${o.googleEnabled ? `${googleButton(`${base}/google`, "Sign up with Google")}<div class="or">or with email</div>` : ""}
<form class="stack" method="post" action="${base}/signup" data-once>
  ${hidden("csrf", o.csrf)}
  ${textField({ id: "name", name: "name", label: "Name", type: "text", attrs: 'autocomplete="name" required maxlength="100"', value: o.name ?? "" })}
  ${emailField({ autocomplete: "email", value: o.email })}
  ${passwordField({
    id: "password",
    name: "password",
    label: "Password",
    autocomplete: "new-password",
    minlength: MIN_PASSWORD_LENGTH,
    hint: `At least ${MIN_PASSWORD_LENGTH} characters.`,
  })}
  ${submit("Create account")}
</form>
<div class="links"><a href="${base}">I already have an account</a></div>`,
    ),
  });
}

export function verifyPage(o: InteractionBase & { email: string }): string {
  const base = `/interaction/${encodeURIComponent(o.uid)}`;
  return authLayout({
    title: "Verify your email",
    nonce: o.nonce,
    branding: o.branding,
    content: authCard(
      "Check your email",
      `We sent a 6-digit code to <strong>${e(o.email)}</strong>. It works for 15 minutes.`,
      `${alerts(o)}
<form class="stack" method="post" action="${base}/verify" data-once>
  ${hidden("csrf", o.csrf)}
  ${textField({
    id: "code",
    name: "code",
    label: "Verification code",
    type: "text",
    inputClass: "input--code",
    attrs: 'inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required autofocus',
  })}
  ${submit("Verify and continue")}
</form>
<form method="post" action="${base}/verify/resend">
  ${hidden("csrf", o.csrf)}
  <button class="btn btn--secondary btn--block" type="submit">Send a new code</button>
</form>
<div class="links"><a href="${base}">Use a different account</a></div>`,
    ),
  });
}

export function forgotPage(o: InteractionBase & { email?: string; sent?: boolean }): string {
  const base = `/interaction/${encodeURIComponent(o.uid)}`;
  const body = o.sent
    ? `<div class="banner banner--good" role="status">${icon("check")}<span>If an account exists for that email, a reset link is on its way. It works for one hour.</span></div>
<div class="links"><a href="${base}">Back to sign in</a></div>`
    : `${alerts(o)}
<form class="stack" method="post" action="${base}/forgot" data-once>
  ${hidden("csrf", o.csrf)}
  ${emailField({ autocomplete: "email", value: o.email, autofocus: true })}
  ${submit("Email me a reset link")}
</form>
<div class="links"><a href="${base}">Back to sign in</a></div>`;
  return authLayout({
    title: "Forgot password",
    nonce: o.nonce,
    branding: o.branding,
    content: authCard("Forgot your password?", "We’ll email you a link to set a new one.", body),
  });
}

export function resetPage(o: Base & { token: string; email: string }): string {
  return authLayout({
    title: "Set a new password",
    nonce: o.nonce,
    branding: null,
    content: authCard(
      "Set a new password",
      `For <strong>${e(o.email)}</strong>. You’ll be signed out everywhere else.`,
      `${alerts(o)}
<form class="stack" method="post" action="/reset/${e(encodeURIComponent(o.token))}" data-once>
  ${passwordField({
    id: "password",
    name: "password",
    label: "New password",
    autocomplete: "new-password",
    minlength: MIN_PASSWORD_LENGTH,
    hint: `At least ${MIN_PASSWORD_LENGTH} characters.`,
  })}
  ${submit("Save new password")}
</form>`,
    ),
  });
}

/** A blocking error (design system §7.5 alert card): what happened and the way out. */
function alertCard(title: string, lines: string[], actions: { href: string; label: string }[]): string {
  return `<div class="alert" role="alert">
<span class="icon-tile icon-tile--sm icon-tile--on">${icon("alert-triangle")}</span>
<div class="alert__body">
<h1 class="alert__title">${e(title)}</h1>
${lines.map((l) => `<p class="alert__text">${e(l)}</p>`).join("")}${
    actions.length
      ? `<div class="actions">${actions.map((l) => `<a class="btn btn--secondary btn--sm" href="${e(l.href)}">${e(l.label)}</a>`).join("")}</div>`
      : ""
  }
</div>
</div>`;
}

export function messagePage(o: {
  nonce: string;
  title: string;
  message: string;
  error?: boolean;
  links?: { href: string; label: string }[];
  accountLink?: boolean;
}): string {
  const links = o.links ?? [];
  const content = o.error
    ? alertCard(o.title, [o.message], links)
    : `<section class="card card--auth" aria-labelledby="page-title">
<span class="icon-tile icon-tile--good">${icon("check")}</span>
<div class="intro"><h1 class="t-title-page" id="page-title">${e(o.title)}</h1><p class="t-body-l tx2" role="status">${e(o.message)}</p></div>
${links
  .map((l, i) => `<a class="btn ${i === 0 ? "btn--primary btn--lg" : "btn--secondary"} btn--block" href="${e(l.href)}">${e(l.label)}</a>`)
  .join("")}
</section>`;
  return authLayout({ title: o.title, nonce: o.nonce, branding: null, accountLink: o.accountLink, content });
}

/** RP-initiated logout: submits itself, with a one-click button as fallback. */
export function logoutPage(o: { nonce: string; form: string; appName?: string }): string {
  // oidc-provider hands over a form with id "op.logoutForm" holding the xsrf
  // token; add logout=yes so the whole SSO session ends, then auto-submit.
  const form = o.form
    .replace('id="op.logoutForm"', 'id="op.logoutForm" data-autosubmit')
    .replace("</form>", `${hidden("logout", "yes")}</form>`);
  return authLayout({
    title: "Signing out",
    nonce: o.nonce,
    branding: null,
    content: authCard(
      `Signing you out${o.appName ? ` of ${e(o.appName)}` : ""}…`,
      "This signs you out of SpendLog, Trippin and InFrame in this browser.",
      `${form}
<button class="btn btn--primary btn--lg btn--block" type="submit" form="op.logoutForm">Sign out</button>`,
    ),
  });
}

export function errorPage(o: { nonce: string; title: string; detail?: string }): string {
  return authLayout({
    title: o.title,
    nonce: o.nonce,
    branding: null,
    content: alertCard(o.title, [...(o.detail ? [o.detail] : []), "Go back to the app and try signing in again."], []),
  });
}

export interface AccountView extends Base {
  csrf: string;
  googleEnabled: boolean;
  connectedApps: Branding[];
  user: {
    name: string;
    email: string;
    emailVerified: boolean;
    picture?: string | null;
    hasPassword: boolean;
    hasGoogle: boolean;
  };
}

/** A settings card's header: an icon tile, the title and a sub-line. */
function cardHead(id: string, iconName: IconName, title: string, sub: string, tone = ""): string {
  return `<div class="card__head"><span class="icon-tile${tone ? ` ${tone}` : ""}">${icon(iconName)}</span><div><h2 class="t-title-section" id="${id}">${e(
    title,
  )}</h2>${sub ? `<p class="t-body-s tx3">${e(sub)}</p>` : ""}</div></div>`;
}

export function accountPage(o: AccountView): string {
  const u = o.user;
  const initial = (u.name || u.email).trim().charAt(0).toUpperCase();
  const avatar = u.picture
    ? `<img class="avatar" src="${e(u.picture)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="avatar" aria-hidden="true">${e(initial)}</span>`;
  const csrf = hidden("csrf", o.csrf);

  const profileCard = `<section class="card" aria-labelledby="profile-title">
  <div class="profile">${avatar}<div class="profile__who"><h2 class="t-title-section" id="profile-title">${e(u.name)}</h2><div class="profile__meta"><span>${e(
    u.email,
  )}</span>${
    u.emailVerified
      ? `<span class="badge badge--good">${icon("check", 14)}Verified</span>`
      : `<span class="badge badge--warn">Not verified</span>`
  }</div></div></div>
  <form class="inline-form" method="post" action="/account/name" data-once>
    ${csrf}
    ${textField({ id: "name", name: "name", label: "Name", type: "text", attrs: 'autocomplete="name" required maxlength="100"', value: u.name })}
    <button class="btn btn--primary btn--lg" type="submit">Save name</button>
  </form>
</section>`;

  const appsCard = `<section class="card" aria-labelledby="apps-title">
  ${cardHead("apps-title", "users", "Apps using this account", "")}
  ${
    o.connectedApps.length
      ? `<ul class="apps">${o.connectedApps
          .map(
            (b) =>
              `<li class="app-row ${e(b.className)}">${mark(markFor(b.className))}<span class="app-row__name">${e(b.name)}</span></li>`,
          )
          .join("")}</ul>`
      : `<div class="empty"><span class="icon-tile icon-tile--neutral">${icon("users")}</span><p>None yet. Sign in to SpendLog, Trippin or InFrame with this account.</p></div>`
  }
</section>`;

  const passwordCard = `<section class="card" aria-labelledby="password-title">
  ${cardHead(
    "password-title",
    "lock",
    u.hasPassword ? "Change password" : "Set a password",
    u.hasPassword
      ? "You’ll stay signed in here; every other device and app is signed out."
      : "Lets you sign in with your email as well as with Google.",
  )}
  <form class="stack" method="post" action="/account/password" data-once>
    ${csrf}
    <div class="field-row">
    ${
      u.hasPassword
        ? passwordField({ id: "current", name: "current", label: "Current password", autocomplete: "current-password" })
        : ""
    }
    ${passwordField({
      id: "new",
      name: "password",
      label: "New password",
      autocomplete: "new-password",
      minlength: MIN_PASSWORD_LENGTH,
      hint: `At least ${MIN_PASSWORD_LENGTH} characters.`,
    })}
    </div>
    <div class="actions"><button class="btn btn--primary" type="submit">${u.hasPassword ? "Change password" : "Set password"}</button></div>
  </form>
</section>`;

  let googleSub: string;
  let googleBody: string;
  if (u.hasGoogle) {
    if (u.hasPassword) {
      googleSub = "Your Google account is linked. You can sign in with it or with your password.";
      googleBody = `<form method="post" action="/account/google/unlink" data-once>${csrf}<button class="btn btn--secondary" type="submit">Unlink Google</button></form>`;
    } else {
      googleSub = "";
      googleBody = `<div class="notice">${icon("info", 18)}<span>Google is your only way to sign in. Set a password before unlinking it.</span></div>`;
    }
  } else if (o.googleEnabled) {
    googleSub = "Link Google to sign in with one tap.";
    googleBody = `<div class="actions">${googleButton("/account/google/link", "Link Google", "md")}</div>`;
  } else {
    googleSub = "Google sign-in isn’t available on this server.";
    googleBody = "";
  }
  const googleCard = `<section class="card" aria-labelledby="google-title">
  <div class="card__head"><span class="icon-tile">${icon("link")}</span><div><h2 class="t-title-section" id="google-title">Google</h2>${
    googleSub ? `<p class="t-body-s tx3">${e(googleSub)}</p>` : ""
  }</div>${
    u.hasGoogle ? '<span class="badge badge--good">Linked</span>' : '<span class="badge badge--neutral">Not linked</span>'
  }</div>
  ${googleBody}
</section>`;

  return pageLayout({
    title: "Your account",
    nonce: o.nonce,
    body: `<div class="page-head"><h1 class="t-title-page">Your account</h1><p class="t-body-s tx3">One account for SpendLog, Trippin and InFrame.</p></div>
${alerts(o)}
<div class="cols">
<div class="col col--main">
${profileCard}
${passwordCard}
<section class="card" aria-labelledby="signout-title">
  ${cardHead("signout-title", "shield", "Sign out", "")}
  <div class="setting-row">
    <div class="setting-row__text"><p class="t-title-card">This browser</p><p class="t-body-s tx3">Sign out of all three apps here only.</p></div>
    <a class="btn btn--secondary" href="/account/signout">Sign out</a>
  </div>
  <div class="setting-row">
    <div class="setting-row__text"><p class="t-title-card">Every device</p><p class="t-body-s tx3">Signs you out of every app on every device, including this browser.</p></div>
    <form method="post" action="/account/signout-everywhere" data-once>${csrf}<button class="btn btn--secondary" type="submit">Sign out everywhere</button></form>
  </div>
</section>
</div>
<div class="col col--side">
${appsCard}
${googleCard}
<section class="card" aria-labelledby="delete-title">
  ${cardHead(
    "delete-title",
    "trash",
    "Delete account",
    "Permanently deletes your sign-in account. Each app keeps its own data until you delete it there. Type your email to confirm.",
    "icon-tile--crit",
  )}
  <form class="stack" method="post" action="/account/delete" data-once>
    ${csrf}
    ${textField({ id: "confirm", name: "confirm", label: "Your email", type: "email", attrs: 'autocomplete="off" required maxlength="254"' })}
    <div class="actions"><button class="btn btn--danger" type="submit">${icon("trash", 18)}Delete my account</button></div>
  </form>
</section>
</div>
</div>`,
  });
}
