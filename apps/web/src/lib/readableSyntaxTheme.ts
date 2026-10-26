import {
  getResolvedOrResolveTheme,
  registerCustomTheme,
  type ThemeRegistrationResolved,
} from "@pierre/diffs";

/** pierre-light with every syntax color darkened until it reads on every light code surface. */
export const READABLE_LIGHT_THEME_NAME = "t3-light";

const MIN_CONTRAST = 4.5;
// The darkest light code surface is a changed word on a deleted line (#f8d3d4, luminance
// 0.71), rounded down for margin.
const DARKEST_SURFACE_LUMINANCE = 0.69;

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function contrastOnLightCode(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb.map(channelLuminance) as [number, number, number];
  return (DARKEST_SURFACE_LUMINANCE + 0.05) / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

/** Darkens a #rrggbb(aa) color in steps that keep its hue until it reads on light code. */
export function readableOnLightCode(color: string, minContrast = MIN_CONTRAST): string {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (!match) return color;
  let rgb = [0, 2, 4].map((start) => Number.parseInt(match[1]!.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
  if (contrastOnLightCode(rgb) >= minContrast) return color;
  while (contrastOnLightCode(rgb) < minContrast) {
    rgb = rgb.map((channel) => Math.floor(channel * 0.96)) as [number, number, number];
  }
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}${match[2] ?? ""}`;
}

// Pierre 1.5 resolves themes to the standard Shiki settings array.
type SyntaxTheme = ThemeRegistrationResolved & {
  readonly settings?: ReadonlyArray<{
    readonly scope?: string | ReadonlyArray<string>;
    readonly settings?: Readonly<Record<string, unknown>>;
  }>;
};

const FURTHER_COLORS = new Set(["#1ca1c7", "#636363", "#1a85d4"]);
const FURTHER_MIN_CONTRAST = 6;

/** The t3-light color for a pierre-light syntax color. */
export function readableSyntaxColor(color: string): string {
  return readableOnLightCode(
    color,
    FURTHER_COLORS.has(color.toLowerCase()) ? FURTHER_MIN_CONTRAST : MIN_CONTRAST,
  );
}

function withReadableSyntax(theme: ThemeRegistrationResolved): ThemeRegistrationResolved {
  const source = theme as SyntaxTheme;
  const settings = source.settings?.map((entry) => {
    const foreground = entry.settings?.foreground;
    return typeof foreground === "string"
      ? { ...entry, settings: { ...entry.settings, foreground: readableSyntaxColor(foreground) } }
      : entry;
  });
  return { ...theme, name: READABLE_LIGHT_THEME_NAME, ...(settings ? { settings } : {}) };
}

// Themes resolve on the main thread and reach the diff workers already resolved.
registerCustomTheme(READABLE_LIGHT_THEME_NAME, async () => {
  const base = await getResolvedOrResolveTheme("pierre-light");
  return withReadableSyntax(base);
});
