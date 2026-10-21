// THE ONE PLACE for visual values: colours, fonts, sizes, radii, spacing.
//
// The values are the shared suite design system (docs/design-system.md in
// the SpendLog repo, §3, §5 and §9.1). Token names are the design system's
// own short names (--bg, --sf, --tx, --ac ...) so design and code read the
// same. Page templates use only these custom properties, through the shared
// classes below; the emails inline the same values (services/mailer.ts).
//
// Theme selection: light by default, dark from prefers-color-scheme, and an
// explicit <html data-theme="light|dark"> wins over the OS setting.
//
// Accent: this site belongs to every app, so its own accent is neutral ink
// (design system §10, "Identity"). A sign-in started by a specific app takes
// that app's accent quad instead, through an `app-<name>` class (on <html>
// for the whole page, or on any element, e.g. an app's logo mark in a list).

/** Font stacks and the Google Fonts stylesheet (design system §4.1, §11). */
export const FONT_SANS = "'IBM Plex Sans', system-ui, sans-serif";
export const FONT_MONO = "'IBM Plex Mono', ui-monospace, monospace";
export const FONT_STYLESHEET_URL =
  "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap";
/** Origins the page CSP has to allow for the fonts above. */
export const FONT_CSS_ORIGIN = "https://fonts.googleapis.com";
export const FONT_FILE_ORIGIN = "https://fonts.gstatic.com";

/** Light theme colours (design system §3.1, export values). */
export const LIGHT = {
  canvas: "#E4E1D8",
  bg: "#F4F2EC",
  sf: "#FFFFFF",
  sf2: "#FAF9F5",
  sunk: "#ECE9E1",
  ln: "#E2DED4",
  ln2: "#C7C2B5",
  tx: "#18191D",
  tx2: "#4C4D53",
  tx3: "#67686E",
  // Identity's own accent: neutral ink (§10).
  ac: "#18191D",
  "ac-tx": "#FFFFFF",
  "ac-soft": "#ECE9E1",
  "ac-line": "#C7C2B5",
  good: "#15724A",
  "good-soft": "#E1F0E6",
  warn: "#8F5200",
  "warn-fill": "#E39A2E",
  "warn-soft": "#FBEED6",
  crit: "#B3302A",
  "crit-fill": "#D9473E",
  "crit-soft": "#FBE5E2",
  hatch: "#C7C2B5",
  shadow: "0 1px 2px rgba(24,25,29,.06),0 2px 8px rgba(24,25,29,.05)",
  shadow2: "0 16px 40px rgba(24,25,29,.18)",
  scrim: "rgba(24,25,29,.42)",
} as const;

export type ColorToken = keyof typeof LIGHT;

/** Dark theme colours (design system §3.1, export values). */
export const DARK: Record<ColorToken, string> = {
  canvas: "#08090A",
  bg: "#111214",
  sf: "#1A1B1E",
  sf2: "#202125",
  sunk: "#0C0D0F",
  ln: "#2B2D32",
  ln2: "#3D3F46",
  tx: "#EDEBE6",
  tx2: "#BEBCB6",
  tx3: "#9A9893",
  ac: "#EDEBE6",
  "ac-tx": "#111214",
  "ac-soft": "#202125",
  "ac-line": "#3D3F46",
  good: "#56C892",
  "good-soft": "#12291D",
  warn: "#F2B661",
  "warn-fill": "#E9A240",
  "warn-soft": "#2E2312",
  crit: "#FF8C80",
  "crit-fill": "#E45B50",
  "crit-soft": "#341A19",
  hatch: "#4A4C53",
  shadow: "0 0 0 1px rgba(255,255,255,.02)",
  shadow2: "0 16px 40px rgba(0,0,0,.6)",
  scrim: "rgba(0,0,0,.6)",
};

type AccentQuad = Record<"ac" | "ac-tx" | "ac-soft" | "ac-line", string>;

/** Per-app accent quads (design system §10), keyed by the Branding class. */
export const APP_ACCENTS: Record<string, { light: AccentQuad; dark: AccentQuad }> = {
  "app-spendlog": {
    light: { ac: "#2C4FCB", "ac-tx": "#FFFFFF", "ac-soft": "#E6EBFB", "ac-line": "#B9C6F2" },
    dark: { ac: "#93A8FF", "ac-tx": "#0D1430", "ac-soft": "#1D2544", "ac-line": "#34407A" },
  },
  "app-trippin": {
    light: { ac: "#0A6E86", "ac-tx": "#FFFFFF", "ac-soft": "#E0F1F5", "ac-line": "#A9D6E1" },
    dark: { ac: "#6CCBE3", "ac-tx": "#062029", "ac-soft": "#10282F", "ac-line": "#1F4E5A" },
  },
  "app-inframe": {
    light: { ac: "#6A3FC4", "ac-tx": "#FFFFFF", "ac-soft": "#EEE8FB", "ac-line": "#CFC0F1" },
    dark: { ac: "#BBA4FF", "ac-tx": "#1C0F3D", "ac-soft": "#251D3D", "ac-line": "#463878" },
  },
};

/** The accent class for a Branding class, or "" for the neutral identity accent. */
export function accentClass(className: string | undefined): string {
  return className && className in APP_ACCENTS ? className : "";
}

/** Everything that isn't a colour (design system §4, §5). */
export const SCALE = {
  "font-sans": FONT_SANS,
  "font-mono": FONT_MONO,
  // Radii (§5.2)
  "r-xs": "3px",
  "r-sm": "6px",
  "r-md": "10px",
  "r-lg": "12px",
  "r-xl": "14px",
  "r-2xl": "16px",
  "r-3xl": "20px",
  "r-full": "999px",
  // Page side padding (§5.6): phone, tablet, desktop.
  "pad-phone": "16px",
  "pad-tablet": "24px",
  "pad-desktop": "32px",
  // Motion (§5.5)
  "dur-fast": "120ms",
  dur: "200ms",
  ease: "cubic-bezier(.2,0,0,1)",
} as const;

const declarations = (tokens: Record<string, string>) =>
  Object.entries(tokens)
    .map(([k, v]) => `--${k}:${v}`)
    .join(";");

const DARK_OS = ":root:not([data-theme=light])";
const DARK_SET = ":root[data-theme=dark]";

// Order matters: the accent rules come after the base theme so that, at equal
// specificity, an app's accent wins over the neutral one.
const accentCss = Object.entries(APP_ACCENTS)
  .map(
    ([cls, { light, dark }]) =>
      `.${cls}{${declarations(light)}}` +
      `@media (prefers-color-scheme:dark){${DARK_OS} .${cls},${DARK_OS}.${cls}{${declarations(dark)}}}` +
      `${DARK_SET} .${cls},${DARK_SET}.${cls}{${declarations(dark)}}`,
  )
  .join("\n");

const TOKEN_CSS = `
:root{color-scheme:light;${declarations(SCALE)};${declarations(LIGHT)}}
@media (prefers-color-scheme:dark){${DARK_OS}{color-scheme:dark;${declarations(DARK)}}}
${DARK_SET}{color-scheme:dark;${declarations(DARK)}}
${accentCss}
`;

// Shared classes. Colours come only from the custom properties above; sizes
// are the design system's (§4.2 type scale, §5 spacing, §7 components).
const COMPONENT_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{background:var(--bg);color:var(--tx);font:14px/20px var(--font-sans);-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);min-height:100vh}
h1,h2,h3,p{margin:0}
a{color:var(--ac);text-underline-offset:3px}
a:hover{color:var(--tx)}
:focus-visible{outline:3px solid var(--ac);outline-offset:3px}
[hidden]{display:none!important}
svg{flex:none}
.num{font-variant-numeric:tabular-nums lining-nums}
.mono{font-family:var(--font-mono);font-variant-numeric:tabular-nums}
.tx2{color:var(--tx2)}.tx3{color:var(--tx3)}
.t-display{font-size:40px;line-height:48px;font-weight:600;letter-spacing:-.02em}
.t-title-page{font-size:22px;line-height:28px;font-weight:600}
.t-title-section{font-size:17px;line-height:24px;font-weight:600}
.t-title-card{font-size:15px;line-height:20px;font-weight:600}
.t-body-l{font-size:15px;line-height:22px}
.t-body-s{font-size:13px;line-height:18px}
.t-caption{font-size:12px;line-height:17px}

/* Logo (§7.16): 28 square, rx 8, accent fill, 2.2 round-cap glyph in ac-tx. */
.logo{display:inline-flex;align-items:center;gap:10px;color:var(--tx);text-decoration:none;font-size:18px;line-height:24px;font-weight:700;letter-spacing:-.01em}
.mark__bg{fill:var(--ac)}
.mark__glyph{fill:none;stroke:var(--ac-tx);stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}

/* Sign-in layout (§6.2, §9.5): brand panel + form panel, full width. */
.auth{display:flex;flex-direction:column;min-height:100vh;background:var(--bg)}
.auth__brand{min-width:0;background:var(--sf2);border-bottom:1px solid var(--ln);padding:24px var(--pad-phone);display:flex;flex-direction:column;gap:24px}
.auth__form{min-width:0;padding:24px var(--pad-phone) 40px;display:flex;justify-content:center;align-items:flex-start}
.auth__col{width:100%;max-width:440px;display:flex;flex-direction:column;gap:24px}
.brand__top{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.brand__top .spacer{flex:1}
.brand__link{font-size:14px;line-height:20px;font-weight:600}
.brand__copy{max-width:560px;display:flex;flex-direction:column;gap:12px}
.brand__copy .t-display{font-size:28px;line-height:34px}
.brand__lede{display:none;color:var(--tx2)}
.benefits{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px;max-width:560px}
.benefit{display:flex;align-items:center;gap:12px;font-size:14px;line-height:20px;color:var(--tx)}
.glimpse{display:none}
@media (min-width:600px){
  .auth__brand{padding:32px var(--pad-tablet)}
  .auth__form{padding:32px var(--pad-tablet) 48px}
  .brand__lede{display:block}
  .brand__copy .t-display{font-size:40px;line-height:48px}
}
@media (min-width:1024px){
  .auth{flex-direction:row}
  .auth__brand{flex:1 1 520px;border-bottom:0;border-right:1px solid var(--ln);padding:40px var(--pad-desktop);gap:32px}
  .auth__form{flex:1 1 480px;padding:40px var(--pad-desktop);align-items:center}
  .glimpse{display:flex}
}

/* The "who is asking" glimpse in the brand panel. */
.glimpse{max-width:560px;flex-direction:column;background:var(--sf);border:1px solid var(--ln);border-radius:var(--r-xl);box-shadow:var(--shadow);padding:20px;gap:12px}
.glimpse__head{display:flex;flex-direction:column;gap:2px}
.apps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.app-row{display:flex;align-items:center;gap:12px;min-height:48px;padding:10px 0;border-bottom:1px solid var(--ln)}
.app-row:last-child{border-bottom:0}
.app-row__name{flex:1;min-width:0;font-size:14px;line-height:20px;font-weight:500}
.app-row--asking{background:var(--ac-soft);box-shadow:inset 0 0 0 1px var(--ac-line);border-radius:var(--r-md);border-bottom-color:transparent;padding:10px 12px;margin:0 -12px}

/* Cards (§7.5). Flat: a border, never a shadow. */
.card{background:var(--sf);border:1px solid var(--ln);border-radius:var(--r-xl);padding:20px;display:flex;flex-direction:column;gap:16px;min-width:0}
.card--auth{gap:20px}
@media (min-width:600px){.card--auth{padding:32px}}
.card__head{display:flex;align-items:flex-start;gap:12px}
.card__head > div{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0}
.intro{display:flex;flex-direction:column;gap:4px}
.stack{display:flex;flex-direction:column;gap:16px}
.actions{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}

/* Icon tiles (§7.5) */
.icon-tile{width:40px;height:40px;border-radius:var(--r-md);display:flex;align-items:center;justify-content:center;flex:none;background:var(--ac-soft);color:var(--ac)}
.icon-tile--sm{width:36px;height:36px}
.icon-tile--neutral{background:var(--sunk);color:var(--tx2)}
.icon-tile--good{background:var(--good-soft);color:var(--good)}
.icon-tile--crit{background:var(--crit-soft);color:var(--crit)}
.icon-tile--on{background:var(--sf);color:var(--crit)}

/* Fields (§7.2) */
.field{display:flex;flex-direction:column;gap:6px}
.label{font-size:12px;line-height:16px;font-weight:600;letter-spacing:.02em;color:var(--tx2)}
.input{width:100%;height:52px;border-radius:var(--r-md);border:1px solid var(--ln2);background:var(--sf);color:var(--tx);padding:0 14px;font:inherit;font-size:15px;line-height:22px}
.input::placeholder{color:var(--tx3)}
.input:focus{outline:none;border:2px solid var(--ac);padding:0 13px}
.input[aria-invalid=true]{border:2px solid var(--crit);padding:0 13px}
.input--code{font-family:var(--font-mono);font-size:22px;letter-spacing:.4em;font-variant-numeric:tabular-nums}
.input.is-revealed{font-family:var(--font-mono)}
.help{font-size:12px;line-height:16px;color:var(--tx3)}
.pw{position:relative}
.pw .input{padding-right:52px}
.pw .input:focus{padding-right:51px}
.eye{position:absolute;right:2px;top:2px;width:48px;height:48px;border:0;background:transparent;color:var(--tx2);border-radius:var(--r-md);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.eye:hover{color:var(--tx)}
.eye:focus-visible{outline-offset:-3px}
.eye .i-off{display:none}
.eye[aria-pressed=true] .i-on{display:none}
.eye[aria-pressed=true] .i-off{display:block}

/* Buttons (§7.1) */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 20px;border-radius:var(--r-lg);border:1px solid transparent;font:inherit;font-size:15px;line-height:20px;font-weight:600;cursor:pointer;text-decoration:none;transition:background-color var(--dur-fast) var(--ease),color var(--dur-fast) var(--ease)}
.btn--lg{min-height:52px}
.btn--sm{min-height:40px;padding:0 16px;font-size:14px}
.btn--block{width:100%}
.btn--primary{background:var(--ac);color:var(--ac-tx)}
.btn--primary:hover{background:color-mix(in srgb,var(--ac) 90%,var(--tx));color:var(--ac-tx)}
.btn--secondary{background:var(--sf);color:var(--tx);border-color:var(--ln2)}
.btn--secondary:hover{background:var(--sf2);color:var(--tx)}
.btn--ghost{background:transparent;color:var(--ac);padding:0 16px}
.btn--ghost:hover{background:var(--sf2);color:var(--ac)}
.btn--danger{background:transparent;color:var(--crit);border-color:var(--crit-soft);padding:0 16px}
.btn--danger:hover{background:var(--crit-soft);color:var(--crit)}
.btn:disabled{background:var(--sunk);color:var(--tx3);border-color:transparent;cursor:not-allowed}
.g{width:20px;height:20px;border-radius:50%;background:var(--ac);color:var(--ac-tx);display:inline-flex;align-items:center;justify-content:center;font-size:12px;line-height:1;font-weight:600;flex:none}
.or{display:flex;align-items:center;gap:12px;color:var(--tx3);font-size:12px;line-height:16px}
.or::before,.or::after{content:"";flex:1;height:1px;background:var(--ln)}
.links{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 16px;font-size:14px;line-height:20px;font-weight:600}

/* Banners and alerts (§7.11, §7.5) */
.banner{display:flex;align-items:flex-start;gap:12px;border-radius:var(--r-lg);padding:10px 14px;font-size:15px;line-height:20px;font-weight:600}
.banner svg{margin-top:0}
.banner--crit{background:var(--crit-soft);color:var(--crit)}
.banner--good{background:var(--good-soft);color:var(--good)}
.alert{background:var(--crit-soft);border-radius:var(--r-xl);padding:16px;display:flex;gap:12px;align-items:flex-start}
.alert__body{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.alert__title{font-size:15px;line-height:20px;font-weight:600;color:var(--crit)}
.alert__text{font-size:13px;line-height:18px;color:var(--tx2)}
.alert .actions{margin-top:8px}
.notice{background:var(--sunk);border-radius:var(--r-lg);padding:12px 14px;display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:18px;color:var(--tx2)}

/* Badges (§7.4) */
.badge{height:24px;border-radius:var(--r-sm);padding:0 8px;display:inline-flex;align-items:center;gap:4px;font-size:12px;line-height:16px;font-weight:600;white-space:nowrap}
.badge--good{background:var(--good-soft);color:var(--good)}
.badge--warn{background:var(--warn-soft);color:var(--warn)}
.badge--neutral{background:var(--sunk);color:var(--tx2)}
.badge--on{background:var(--sf);color:var(--ac)}

/* Empty state (§7.11) */
.empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:14px 12px;border:1px dashed var(--ln2);border-radius:var(--r-lg);font-size:13px;line-height:18px;color:var(--tx2)}

/* Account page shell (§6.1): header + full-width main, no centred column. */
.page{min-height:100vh;display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;gap:12px;padding:12px var(--pad-phone);border-bottom:1px solid var(--ln);background:var(--bg)}
.topbar .spacer{flex:1}
.main{flex:1;padding:20px var(--pad-phone) 40px;display:flex;flex-direction:column;gap:20px}
.page-head{display:flex;flex-direction:column;gap:4px}
.cols{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}
.col{display:flex;flex-direction:column;gap:16px;min-width:0}
.col--main{flex:8 1 560px}
.col--side{flex:4 1 320px}
.field-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:16px;align-items:start}
.setting-row{display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px;padding-top:16px;border-top:1px solid var(--ln)}
.setting-row__text{flex:1 1 240px;display:flex;flex-direction:column;gap:2px;min-width:0}
.profile{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.profile__who{display:flex;flex-direction:column;gap:4px;min-width:0}
.profile__meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--tx3);font-size:13px;line-height:18px;overflow-wrap:anywhere}
.avatar{width:48px;height:48px;border-radius:50%;object-fit:cover;background:var(--tx);color:var(--bg);display:inline-flex;align-items:center;justify-content:center;font-size:17px;font-weight:700;flex:none}
.inline-form{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
.inline-form .field{flex:1 1 260px}
.inline-form .btn{flex:none}
@media (min-width:600px){
  .topbar{padding:16px var(--pad-tablet)}
  .main{padding:24px var(--pad-tablet) 48px}
  .cols,.col{gap:20px}
}
@media (min-width:1024px){
  .topbar{padding:16px var(--pad-desktop)}
  .main{padding:24px var(--pad-desktop) 48px}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:0ms!important;animation-duration:0ms!important}}
`;

export const STYLESHEET = TOKEN_CSS + COMPONENT_CSS;
