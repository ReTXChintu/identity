// THE ONE PLACE for visual values: colours, fonts, sizes, radii, spacing.
//
// A shared design system for SpendLog, Trippin, InFrame and this site is
// being written to docs/design-system.md (in the SpendLog repo). When it
// lands, swap the values in TOKENS / DARK_TOKENS below for its tokens; the
// page templates only use these custom properties and the shared classes in
// CSS, so nothing else should need to change.
//
// Theme selection: light by default, dark from prefers-color-scheme, and an
// explicit <html data-theme="light|dark"> wins over the OS setting.

/** Light theme, also the defaults for everything that isn't a colour. */
export const TOKENS = {
  // Typography
  "font-sans": 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  "font-size-xs": "12px",
  "font-size-sm": "13px",
  "font-size-md": "15px",
  "font-size-base": "16px",
  "font-size-lg": "17px",
  "font-size-xl": "20px",
  "font-size-2xl": "24px",
  "font-size-3xl": "36px",
  "font-weight-regular": "400",
  "font-weight-semibold": "600",
  "font-weight-bold": "700",
  "line-height": "1.5",
  // Spacing scale
  "space-1": "4px",
  "space-2": "8px",
  "space-3": "12px",
  "space-4": "16px",
  "space-5": "20px",
  "space-6": "24px",
  "space-7": "28px",
  "space-8": "32px",
  // Page gutters: 16px on phones, 24px on tablets, 32px on desktop.
  "gutter-phone": "16px",
  "gutter-tablet": "24px",
  "gutter-desktop": "32px",
  // Shape
  "radius-sm": "8px",
  "radius-md": "10px",
  "radius-lg": "12px",
  "radius-pill": "999px",
  "control-height": "48px",
  "border-width": "1px",
  "focus-ring": "2px",
  // Colours (light)
  "color-bg": "#f4f5f7",
  "color-surface": "#ffffff",
  "color-text": "#111827",
  "color-text-muted": "#5b6474",
  "color-border": "#d9dde4",
  "color-field": "#ffffff",
  "color-accent": "#2563eb",
  "color-on-accent": "#ffffff",
  "color-on-brand": "#ffffff",
  "color-danger": "#b91c1c",
  "color-on-danger": "#ffffff",
  "color-danger-bg": "#fdecec",
  "color-success": "#047857",
  "color-success-bg": "#e7f6ef",
  // Per-app accent colours (the app chips and "who is asking" icon)
  "color-app-spendlog": "#059669",
  "color-app-trippin": "#ea580c",
  "color-app-inframe": "#7c3aed",
  "color-app-account": "#2563eb",
} as const;

/** Dark theme: colour overrides only. */
export const DARK_TOKENS: Partial<Record<keyof typeof TOKENS, string>> = {
  "color-bg": "#0d1117",
  "color-surface": "#161b22",
  "color-text": "#e6edf3",
  "color-text-muted": "#9aa4b2",
  "color-border": "#2d333b",
  "color-field": "#0d1117",
  "color-accent": "#4c8dff",
  "color-on-accent": "#0b1220",
  "color-danger": "#ff7b72",
  "color-on-danger": "#0b1220",
  "color-danger-bg": "#3a1618",
  "color-success": "#3fb950",
  "color-success-bg": "#12261b",
  "color-app-spendlog": "#34d399",
  "color-app-trippin": "#fb923c",
  "color-app-inframe": "#a78bfa",
  "color-app-account": "#4c8dff",
};

const declarations = (tokens: Record<string, string | undefined>) =>
  Object.entries(tokens)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `--${k}:${v}`)
    .join(";");

const TOKEN_CSS = `
:root{color-scheme:light;${declarations(TOKENS)}}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;${declarations(DARK_TOKENS)}}}
:root[data-theme=dark]{color-scheme:dark;${declarations(DARK_TOKENS)}}
`;

// Shared classes. Values come only from the custom properties above.
const COMPONENT_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--color-bg);color:var(--color-text);font-family:var(--font-sans);font-size:var(--font-size-base);line-height:var(--line-height);min-height:100vh;display:flex;flex-direction:column}
a{color:var(--color-accent)}
.topbar{display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--gutter-phone);border-bottom:var(--border-width) solid var(--color-border);background:var(--color-surface)}
.topbar .brand{font-weight:var(--font-weight-bold)}
.topbar .dots{display:flex;gap:var(--space-1)}
.dot{width:var(--space-3);height:var(--space-3);border-radius:50%}
.dot.spendlog{background:var(--color-app-spendlog)}.dot.trippin{background:var(--color-app-trippin)}.dot.inframe{background:var(--color-app-inframe)}
.topbar .spacer{flex:1}
.topbar a{font-size:var(--font-size-md)}
main{flex:1;width:100%;padding:var(--gutter-phone)}
.split{display:grid;gap:var(--space-4);grid-template-columns:1fr;align-items:start}
.hero{padding:var(--space-2) 0}
.hero h1{font-size:var(--font-size-2xl);line-height:1.25;margin:0 0 var(--space-2)}
.hero p{color:var(--color-text-muted);margin:0}
.apps{display:flex;flex-wrap:wrap;gap:var(--space-2);margin-top:var(--space-4)}
.chip{display:inline-flex;align-items:center;gap:var(--space-2);padding:var(--space-1) var(--space-3) var(--space-1) var(--space-1);border:var(--border-width) solid var(--color-border);border-radius:var(--radius-pill);background:var(--color-surface);font-size:var(--font-size-md)}
.mono{display:inline-grid;place-items:center;width:var(--space-7);height:var(--space-7);border-radius:var(--radius-sm);color:var(--color-on-brand);font-weight:var(--font-weight-bold);font-size:var(--font-size-md);flex:none}
.app-spendlog .mono,.mono.app-spendlog{background:var(--color-app-spendlog)}
.app-trippin .mono,.mono.app-trippin{background:var(--color-app-trippin)}
.app-inframe .mono,.mono.app-inframe{background:var(--color-app-inframe)}
.app-account .mono,.mono.app-account{background:var(--color-app-account)}
.asking{display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3);border-radius:var(--radius-lg);background:var(--color-surface);border:var(--border-width) solid var(--color-border);margin-top:var(--space-4)}
.asking .mono{width:var(--space-8);height:var(--space-8);font-size:var(--font-size-lg);border-radius:var(--radius-md)}
.asking strong{display:block}
.asking span{color:var(--color-text-muted);font-size:var(--font-size-md)}
.card{background:var(--color-surface);border:var(--border-width) solid var(--color-border);border-radius:var(--radius-lg);padding:var(--space-5)}
.card h2{margin:0 0 var(--space-1);font-size:var(--font-size-xl)}
.card h3{margin:0 0 var(--space-2);font-size:var(--font-size-lg)}
.card .sub{color:var(--color-text-muted);margin:0 0 var(--space-4);font-size:var(--font-size-md)}
form{margin:0}
label{display:block;font-weight:var(--font-weight-semibold);font-size:var(--font-size-md);margin:var(--space-3) 0 var(--space-1)}
.input{width:100%;font:inherit;padding:var(--space-3) var(--space-4);border:var(--border-width) solid var(--color-border);border-radius:var(--radius-md);background:var(--color-field);color:var(--color-text);min-height:var(--control-height)}
.input:focus{outline:var(--focus-ring) solid var(--color-accent);outline-offset:1px;border-color:transparent}
.input.code{letter-spacing:var(--space-2);font-size:var(--font-size-2xl);text-align:center;font-variant-numeric:tabular-nums}
.pw{position:relative}
.pw .input{padding-right:calc(var(--control-height) + var(--space-1))}
.eye{position:absolute;top:0;right:0;height:100%;width:var(--control-height);display:grid;place-items:center;background:none;border:0;color:var(--color-text-muted);cursor:pointer;border-radius:0 var(--radius-md) var(--radius-md) 0}
.eye:focus-visible{outline:var(--focus-ring) solid var(--color-accent)}
.eye svg{width:var(--space-5);height:var(--space-5)}
.eye .off{display:none}.eye.on .on{display:none}.eye.on .off{display:block}
.hint{color:var(--color-text-muted);font-size:var(--font-size-sm);margin:var(--space-1) 0 0}
.btn{display:flex;align-items:center;justify-content:center;gap:var(--space-2);width:100%;min-height:var(--control-height);padding:var(--space-3) var(--space-4);margin-top:var(--space-4);border-radius:var(--radius-md);border:var(--border-width) solid transparent;font:inherit;font-weight:var(--font-weight-semibold);cursor:pointer;text-decoration:none;background:var(--color-accent);color:var(--color-on-accent)}
.btn.secondary{background:var(--color-surface);color:var(--color-text);border-color:var(--color-border)}
.btn.danger{background:var(--color-danger);color:var(--color-on-danger)}
.btn.inline{display:inline-flex;width:auto}
.btn svg{width:var(--space-5);height:var(--space-5)}
.or{display:flex;align-items:center;gap:var(--space-3);color:var(--color-text-muted);font-size:var(--font-size-sm);margin:var(--space-4) 0 0}
.or::before,.or::after{content:"";flex:1;height:var(--border-width);background:var(--color-border)}
.links{display:flex;flex-wrap:wrap;justify-content:space-between;gap:var(--space-2) var(--space-4);margin-top:var(--space-4);font-size:var(--font-size-md)}
.alert{padding:var(--space-3) var(--space-4);border-radius:var(--radius-md);margin:0 0 var(--space-3);font-size:var(--font-size-md)}
.alert.error{background:var(--color-danger-bg);color:var(--color-danger)}
.alert.ok{background:var(--color-success-bg);color:var(--color-success)}
.grid{display:grid;gap:var(--space-4);grid-template-columns:1fr}
.profile{display:flex;align-items:center;gap:var(--space-4)}
.avatar{width:calc(var(--control-height) + var(--space-2));height:calc(var(--control-height) + var(--space-2));border-radius:50%;object-fit:cover;background:var(--color-border);display:grid;place-items:center;font-weight:var(--font-weight-bold);font-size:var(--font-size-xl);flex:none}
.badge{display:inline-block;font-size:var(--font-size-xs);font-weight:var(--font-weight-semibold);padding:calc(var(--space-1) / 2) var(--space-2);border-radius:var(--radius-pill);background:var(--color-success-bg);color:var(--color-success)}
.badge.warn{background:var(--color-danger-bg);color:var(--color-danger)}
.muted{color:var(--color-text-muted)}
footer{padding:var(--space-4) var(--gutter-phone);color:var(--color-text-muted);font-size:var(--font-size-sm);border-top:var(--border-width) solid var(--color-border)}
@media (min-width:720px){main{padding:var(--gutter-tablet)}.topbar,footer{padding-left:var(--gutter-tablet);padding-right:var(--gutter-tablet)}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (min-width:960px){main{padding:var(--gutter-desktop)}.topbar,footer{padding-left:var(--gutter-desktop);padding-right:var(--gutter-desktop)}
.split{grid-template-columns:minmax(0,5fr) minmax(0,6fr);gap:var(--space-8);align-items:center;min-height:calc(100vh - 160px)}
.hero h1{font-size:var(--font-size-3xl)}.card{padding:var(--space-7)}.grid{grid-template-columns:repeat(3,minmax(0,1fr))}.span2{grid-column:span 2}}
`;

export const STYLESHEET = TOKEN_CSS + COMPONENT_CSS;
