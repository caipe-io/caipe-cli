import { afterEach, describe, expect, it } from "vitest";
import { getTerminalTheme, parseThemePreference, resolveAutoTheme } from "../src/platform/theme.js";

describe("terminal themes", () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it("detects light and dark terminal backgrounds", () => {
    expect(resolveAutoTheme("15;0")).toBe("dark");
    expect(resolveAutoTheme("0;15")).toBe("light");
    expect(resolveAutoTheme(undefined)).toBe("dark");
  });

  it("provides distinct semantic palettes", () => {
    delete process.env.NO_COLOR;
    const dark = getTerminalTheme("dark");
    const light = getTerminalTheme("light");
    const contrast = getTerminalTheme("high-contrast");

    expect(dark.accent).toBe("cyan");
    expect(light.accent).toBe("blue");
    expect(contrast.accent).toBe("yellow");
    expect(new Set([dark.assistant, light.assistant, contrast.assistant]).size).toBe(3);
  });

  it("lets NO_COLOR override configured themes", () => {
    process.env.NO_COLOR = "1";
    expect(getTerminalTheme("high-contrast").name).toBe("mono");
    expect(getTerminalTheme("high-contrast").colorEnabled).toBe(false);
  });

  it("validates theme names", () => {
    expect(parseThemePreference(" LIGHT ")).toBe("light");
    expect(parseThemePreference("neon")).toBeUndefined();
  });
});
