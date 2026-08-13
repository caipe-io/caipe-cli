import { type ConfiguredTheme, getConfiguredTheme, readSettings, writeSettings } from "./config.js";

export const THEME_PREFERENCES = ["auto", "dark", "light", "high-contrast", "mono"] as const;
export type ThemePreference = ConfiguredTheme;
export type ResolvedThemeName = Exclude<ThemePreference, "auto">;

export interface TerminalTheme {
  preference: ThemePreference;
  name: ResolvedThemeName;
  colorEnabled: boolean;
  accent?: string;
  info?: string;
  success?: string;
  warning?: string;
  danger?: string;
  prompt?: string;
  assistant?: string;
  muted?: string;
  selectedBackground?: string;
  selectedForeground?: string;
  userBackground?: string;
}

const THEMES: Record<ResolvedThemeName, Omit<TerminalTheme, "preference" | "name">> = {
  dark: {
    colorEnabled: true,
    accent: "cyan",
    info: "blue",
    success: "green",
    warning: "yellow",
    danger: "red",
    prompt: "green",
    assistant: "blue",
    muted: "gray",
    selectedBackground: "blue",
    selectedForeground: "white",
    userBackground: "gray",
  },
  light: {
    colorEnabled: true,
    accent: "blue",
    info: "magenta",
    success: "green",
    warning: "yellow",
    danger: "red",
    prompt: "blue",
    assistant: "magenta",
    muted: "gray",
    selectedBackground: "cyan",
    selectedForeground: "black",
    userBackground: "white",
  },
  "high-contrast": {
    colorEnabled: true,
    accent: "yellow",
    info: "cyan",
    success: "greenBright",
    warning: "yellowBright",
    danger: "redBright",
    prompt: "yellowBright",
    assistant: "cyanBright",
    muted: "white",
    selectedBackground: "yellowBright",
    selectedForeground: "black",
    userBackground: "gray",
  },
  mono: { colorEnabled: false },
};

function isThemePreference(value: string | undefined): value is ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference);
}

export function getThemePreference(): ThemePreference {
  const env = process.env.CAIPE_THEME?.trim().toLowerCase();
  if (isThemePreference(env)) return env;
  return getConfiguredTheme() ?? "auto";
}

export function resolveAutoTheme(colorFgBg = process.env.COLORFGBG): ResolvedThemeName {
  const background = colorFgBg?.split(";").at(-1);
  if (background && Number.parseInt(background, 10) >= 7) return "light";
  return "dark";
}

export function getTerminalTheme(preference = getThemePreference()): TerminalTheme {
  const name: ResolvedThemeName =
    process.env.NO_COLOR || preference === "mono"
      ? "mono"
      : preference === "auto"
        ? resolveAutoTheme()
        : preference;
  return { preference, name, ...THEMES[name] };
}

export function setThemePreference(preference: ThemePreference): void {
  const settings = readSettings();
  settings.ui = { ...settings.ui, theme: preference };
  writeSettings(settings);
  applyThemeEnvironment(preference);
}

export function parseThemePreference(value: string): ThemePreference | undefined {
  const normalized = value.trim().toLowerCase();
  return isThemePreference(normalized) ? normalized : undefined;
}

/** Make non-Ink renderers honor the mono theme without overriding user NO_COLOR. */
export function applyThemeEnvironment(preference = getThemePreference()): void {
  if (preference === "mono") {
    if (!process.env.NO_COLOR) process.env.CAIPE_THEME_SET_NO_COLOR = "1";
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "0";
    return;
  }
  if (process.env.CAIPE_THEME_SET_NO_COLOR === "1") {
    delete process.env.NO_COLOR;
    delete process.env.CAIPE_THEME_SET_NO_COLOR;
    delete process.env.FORCE_COLOR;
  }
}

const ANSI_CODES: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  redBright: 91,
  greenBright: 92,
  yellowBright: 93,
  blueBright: 94,
  magentaBright: 95,
  cyanBright: 96,
};

export function ansiColor(color?: string): string {
  const code = color ? ANSI_CODES[color] : undefined;
  return code ? `\x1b[${code}m` : "";
}

export const ANSI_RESET = "\x1b[0m";
export const ANSI_DIM = "\x1b[2m";
