import { escapeHtml as e } from "../security.js";
import type { Branding } from "../oidc/clients.js";
import { MIN_PASSWORD_LENGTH } from "../services/passwords.js";
import { alerts, GOOGLE_ICON, hero, hidden, layout, passwordField } from "./layout.js";

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

function authShell(title: string, opts: { nonce: string; branding: Branding | null }, card: string): string {
  return layout({
    title,
    nonce: opts.nonce,
    body: `<div class="split">${hero(opts.branding)}<section class="card">${card}</section></div>`,
  });
}

function googleButton(href: string, label = "Continue with Google"): string {
  return `<a class="btn secondary" href="${e(href)}">${GOOGLE_ICON}<span>${e(label)}</span></a>`;
}

export function loginPage(o: InteractionBase & { email?: string; googleEnabled: boolean }): string {
  const base = `/interaction/${encodeURIComponent(o.uid)}`;
  return authShell(
    "Sign in",
    o,
    `<h2>Sign in</h2>
<p class="sub">Use your SpendLog, Trippin or InFrame account.</p>
${alerts(o)}
${o.googleEnabled ? `${googleButton(`${base}/google`)}<div class="or">or with email</div>` : ""}
<form method="post" action="${base}/login" data-once>
  ${hidden("csrf", o.csrf)}
  <label for="email">Email</label>
  <input class="input" type="email" id="email" name="email" autocomplete="username" required maxlength="254" value="${e(o.email ?? "")}"${o.email ? "" : " autofocus"}>
  ${passwordField({ id: "password", name: "password", label: "Password", autocomplete: "current-password" })}
  <button class="btn" type="submit">Sign in</button>
</form>
<div class="links">
  <a href="${base}/signup">Create account</a>
  <a href="${base}/forgot">Forgot password?</a>
</div>`,
  );
}

export function signupPage(o: InteractionBase & { email?: string; name?: string; googleEnabled: boolean }): string {
  const base = `/interaction/${encodeURIComponent(o.uid)}`;
  return authShell(
    "Create account",
    o,
    `<h2>Create your account</h2>
<p class="sub">One account works in all three apps.</p>
${alerts(o)}
${o.googleEnabled ? `${googleButton(`${base}/google`, "Sign up with Google")}<div class="or">or with email</div>` : ""}
<form method="post" action="${base}/signup" data-once>
  ${hidden("csrf", o.csrf)}
  <label for="name">Name</label>
  <input class="input" type="text" id="name" name="name" autocomplete="name" required maxlength="100" value="${e(o.name ?? "")}">
  <label for="email">Email</label>
  <input class="input" type="email" id="email" name="email" autocomplete="email" required maxlength="254" value="${e(o.email ?? "")}">
  ${passwordField({
    id: "password",
    name: "password",
    label: "Password",
    autocomplete: "new-password",
    minlength: MIN_PASSWORD_LENGTH,
    hint: `At least ${MIN_PASSWORD_LENGTH} characters.`,
  })}
  <button class="btn" type="submit">Create account</button>
</form>
<div class="links"><a href="${base}">I already have an account</a></div>`,
  );
}

export function verifyPage(o: InteractionBase & { email: string }): string {
  const base = `/interaction/${encodeURIComponent(o.uid)}`;
  return authShell(
    "Verify your email",
    o,
    `<h2>Check your email</h2>
<p class="sub">We sent a 6-digit code to <strong>${e(o.email)}</strong>. It works for 15 minutes.</p>
${alerts(o)}
<form method="post" action="${base}/verify" data-once>
  ${hidden("csrf", o.csrf)}
  <label for="code">Verification code</label>
  <input class="input code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" id="code" name="code" autocomplete="one-time-code" required autofocus>
  <button class="btn" type="submit">Verify and continue</button>
</form>
<form method="post" action="${base}/verify/resend">
  ${hidden("csrf", o.csrf)}
  <button class="btn secondary" type="submit">Send a new code</button>
</form>
<div class="links"><a href="${base}">Use a different account</a></div>`,
  );
}

export function forgotPage(o: InteractionBase & { email?: string; sent?: boolean }): string {
  const base = `/interaction/${encodeURIComponent(o.uid)}`;
  const body = o.sent
    ? `<div class="alert ok" role="status">If an account exists for that email, a reset link is on its way. It works for one hour.</div>
<div class="links"><a href="${base}">Back to sign in</a></div>`
    : `${alerts(o)}
<form method="post" action="${base}/forgot" data-once>
  ${hidden("csrf", o.csrf)}
  <label for="email">Email</label>
  <input class="input" type="email" id="email" name="email" autocomplete="email" required maxlength="254" value="${e(o.email ?? "")}" autofocus>
  <button class="btn" type="submit">Email me a reset link</button>
</form>
<div class="links"><a href="${base}">Back to sign in</a></div>`;
  return authShell(
    "Forgot password",
    o,
    `<h2>Forgot your password?</h2>
<p class="sub">We'll email you a link to set a new one.</p>
${body}`,
  );
}

export function resetPage(o: Base & { token: string; email: string }): string {
  return authShell(
    "Set a new password",
    { nonce: o.nonce, branding: null },
    `<h2>Set a new password</h2>
<p class="sub">For <strong>${e(o.email)}</strong>. You'll be signed out everywhere else.</p>
${alerts(o)}
<form method="post" action="/reset/${e(encodeURIComponent(o.token))}" data-once>
  ${passwordField({
    id: "password",
    name: "password",
    label: "New password",
    autocomplete: "new-password",
    minlength: MIN_PASSWORD_LENGTH,
    hint: `At least ${MIN_PASSWORD_LENGTH} characters.`,
  })}
  <button class="btn" type="submit">Save new password</button>
</form>`,
  );
}

export function messagePage(o: {
  nonce: string;
  title: string;
  message: string;
  error?: boolean;
  links?: { href: string; label: string }[];
  accountLink?: boolean;
}): string {
  const links = (o.links ?? [])
    .map((l, i) => `<a class="btn${i === 0 ? "" : " secondary"}" href="${e(l.href)}">${e(l.label)}</a>`)
    .join("");
  return layout({
    title: o.title,
    nonce: o.nonce,
    accountLink: o.accountLink,
    body: `<div class="split">${hero(null)}<section class="card"><h2>${e(o.title)}</h2>
<div class="alert ${o.error ? "error" : "ok"}" role="${o.error ? "alert" : "status"}">${e(o.message)}</div>${links}</section></div>`,
  });
}

/** RP-initiated logout: submits itself, with a one-click button as fallback. */
export function logoutPage(o: { nonce: string; form: string; appName?: string }): string {
  // oidc-provider hands over a form with id "op.logoutForm" holding the xsrf
  // token; add logout=yes so the whole SSO session ends, then auto-submit.
  const form = o.form
    .replace('id="op.logoutForm"', 'id="op.logoutForm" data-autosubmit')
    .replace("</form>", `${hidden("logout", "yes")}</form>`);
  return layout({
    title: "Signing out",
    nonce: o.nonce,
    body: `<div class="split">${hero(null)}<section class="card">
<h2>Signing you out${o.appName ? ` of ${e(o.appName)}` : ""}…</h2>
<p class="sub">This signs you out of SpendLog, Trippin and InFrame in this browser.</p>
${form}
<button class="btn" type="submit" form="op.logoutForm">Sign out</button>
</section></div>`,
  });
}

export function errorPage(o: { nonce: string; title: string; detail?: string }): string {
  return layout({
    title: o.title,
    nonce: o.nonce,
    body: `<div class="split">${hero(null)}<section class="card"><h2>${e(o.title)}</h2>
${o.detail ? `<div class="alert error" role="alert">${e(o.detail)}</div>` : ""}
<p class="sub">Go back to the app and try signing in again.</p></section></div>`,
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

export function accountPage(o: AccountView): string {
  const u = o.user;
  const initial = (u.name || u.email).trim().charAt(0).toUpperCase();
  const avatar = u.picture
    ? `<img class="avatar" src="${e(u.picture)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="avatar" aria-hidden="true">${e(initial)}</span>`;
  const csrf = hidden("csrf", o.csrf);

  const passwordCard = `<section class="card">
<h3>${u.hasPassword ? "Change password" : "Set a password"}</h3>
<p class="sub">${
    u.hasPassword
      ? "You'll stay signed in here; every other device and app is signed out."
      : "Lets you sign in with your email as well as with Google."
  }</p>
<form method="post" action="/account/password" data-once>
  ${csrf}
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
  <button class="btn" type="submit">${u.hasPassword ? "Change password" : "Set password"}</button>
</form>
</section>`;

  let googleBody: string;
  if (u.hasGoogle) {
    googleBody = u.hasPassword
      ? `<p class="sub">Your Google account is linked. You can sign in with it or with your password.</p>
<form method="post" action="/account/google/unlink" data-once>${csrf}<button class="btn secondary" type="submit">Unlink Google</button></form>`
      : `<p class="sub">Google is your only way to sign in. Set a password before unlinking it.</p>`;
  } else if (o.googleEnabled) {
    googleBody = `<p class="sub">Link Google to sign in with one tap.</p>${googleButton("/account/google/link", "Link Google")}`;
  } else {
    googleBody = `<p class="sub">Google sign-in isn't available on this server.</p>`;
  }

  return layout({
    title: "Your account",
    nonce: o.nonce,
    body: `${alerts(o)}
<div class="grid">
<section class="card span2">
  <div class="profile">${avatar}<div><h2>${e(u.name)}</h2><div class="muted">${e(u.email)} ${
    u.emailVerified ? '<span class="badge">Verified</span>' : '<span class="badge warn">Not verified</span>'
  }</div></div></div>
  <form method="post" action="/account/name" data-once>
    ${csrf}
    <label for="name">Name</label>
    <input class="input" type="text" id="name" name="name" autocomplete="name" required maxlength="100" value="${e(u.name)}">
    <button class="btn inline" type="submit">Save name</button>
  </form>
</section>
<section class="card">
  <h3>Apps using this account</h3>
  ${
    o.connectedApps.length
      ? `<div class="apps">${o.connectedApps
          .map((b) => `<span class="chip ${b.className}"><span class="mono">${e(b.monogram)}</span>${e(b.name)}</span>`)
          .join("")}</div>`
      : '<p class="sub">None yet. Sign in to SpendLog, Trippin or InFrame with this account.</p>'
  }
</section>
${passwordCard}
<section class="card"><h3>Google</h3>${googleBody}</section>
<section class="card">
  <h3>Sign out everywhere</h3>
  <p class="sub">Signs you out of every app on every device, including this browser.</p>
  <form method="post" action="/account/signout-everywhere" data-once>${csrf}<button class="btn secondary" type="submit">Sign out everywhere</button></form>
</section>
<section class="card span2">
  <h3>Delete account</h3>
  <p class="sub">Permanently deletes your sign-in account. Each app keeps its own data until you delete it there. Type your email to confirm.</p>
  <form method="post" action="/account/delete" data-once>
    ${csrf}
    <label for="confirm">Your email</label>
    <input class="input" type="email" id="confirm" name="confirm" autocomplete="off" required maxlength="254">
    <button class="btn danger inline" type="submit">Delete my account</button>
  </form>
</section>
<section class="card">
  <h3>This browser</h3>
  <p class="sub">Sign out of all three apps here only.</p>
  <a class="btn secondary" href="/account/signout">Sign out</a>
</section>
</div>`,
  });
}
