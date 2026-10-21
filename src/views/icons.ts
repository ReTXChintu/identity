// The suite icon set (design system §7.15, docs/design-assets/icons/), inlined
// as SVG: 24 grid, no fill, currentColor stroke 1.75 (2 at 12-14 px), round
// caps and joins. Only the icons these pages use are copied here.
//
// Also the app logo marks (§7.16, §10): a 28 px square, rx 8, in the accent,
// with a 2.2-stroke glyph in ac-tx. Colours come from CSS classes, not
// attributes, so an element's `app-<name>` class picks the accent.

const PATHS = {
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  "eye-off":
    "M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7c1.7 0 3.2-.4 4.5-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2",
  "alert-triangle": "M12 3 2 20h20zM12 10v4M12 17h.01",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01",
  lock: "M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11",
  check: "M5 12.5l4.5 4.5L19 7",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  mail: "M3 6h18v12H3zM3 7l9 6 9-6",
  users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7M22 21v-1a6 6 0 0 0-4-5.6",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  refresh: "M20 11a8 8 0 0 0-14.9-3.9M4 4v4h4M4 13a8 8 0 0 0 14.9 3.9M20 20v-4h-4",
  x: "M6 6l12 12M18 6 6 18",
} as const;

export type IconName = keyof typeof PATHS;

/** An icon, decorative (aria-hidden): label the control it sits in instead. */
export function icon(name: IconName, size = 20, className = ""): string {
  const stroke = size <= 14 ? 2 : 1.75;
  return `<svg${className ? ` class="${className}"` : ""} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${PATHS[name]}"/></svg>`;
}

/** Logo glyphs on the 28 px mark (§10 "Logo glyph concepts"). */
const GLYPHS = {
  // Identity: a keyhole.
  identity: '<circle cx="14" cy="11.5" r="3.2"/><path d="M14 14.7V20.5"/>',
  // SpendLog: two ledger lines plus a cursor (the export's mark).
  spendlog: '<path d="M7 10.5h14M7 17.5h8"/><path d="M18.5 14v7"/>',
  // Trippin: a route line ending in a pin.
  trippin: '<path d="M7 21Q15 21 19 13.5"/><circle cx="19" cy="9" r="2.4"/>',
  // InFrame: four frame corners.
  inframe: '<path d="M7 11V7h4M17 7h4v4M21 17v4h-4M11 21H7v-4"/>',
} as const;

export type MarkName = keyof typeof GLYPHS;

/** "app-spendlog" -> "spendlog"; anything else is the identity mark. */
export function markFor(className: string | undefined): MarkName {
  const name = (className ?? "").replace(/^app-/, "");
  return name in GLYPHS ? (name as MarkName) : "identity";
}

/** The 28 px logo mark, in the accent of whatever `app-<name>` class is in effect. */
export function mark(name: MarkName, size = 28): string {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 28 28" aria-hidden="true" focusable="false"><rect class="mark__bg" width="28" height="28" rx="8"/><g class="mark__glyph">${GLYPHS[name]}</g></svg>`;
}
