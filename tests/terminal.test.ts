import { afterEach, describe, expect, it } from "vitest";
import {
  getMarkdownLayoutWidth,
  getTerminalCapabilities,
} from "../src/platform/terminal/capabilities.js";
import { iterm2InlineImage } from "../src/platform/terminal/images.js";
import { osc8Hyperlink, replaceMarkdownLinksWithOsc8 } from "../src/platform/terminal/links.js";

describe("terminal capabilities", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("disables rich features when NO_COLOR is set", () => {
    process.env.NO_COLOR = "1";
    process.env.TERM_PROGRAM = "iTerm.app";
    const caps = getTerminalCapabilities();
    expect(caps.osc8Links).toBe(false);
    expect(caps.iterm2InlineImages).toBe(false);
  });

  it("enables iTerm2 image protocol when TERM_PROGRAM is iTerm", () => {
    delete process.env.NO_COLOR;
    process.env.TERM_PROGRAM = "iTerm.app";
    process.env.COLORTERM = "truecolor";
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      const caps = getTerminalCapabilities();
      expect(caps.iterm2InlineImages).toBe(true);
      expect(caps.osc8Links).toBe(true);
    } finally {
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    }
  });

  it("computes markdown layout width smaller than terminal columns", () => {
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
    try {
      expect(getMarkdownLayoutWidth("full", 120)).toBe(115);
      expect(getMarkdownLayoutWidth("assistant", 120)).toBe(113);
      expect(getMarkdownLayoutWidth("user", 120)).toBe(113);
    } finally {
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    }
  });
});

describe("OSC 8 links", () => {
  it("wraps label with hyperlink escapes", () => {
    const out = osc8Hyperlink("https://example.com", "Example");
    expect(out).toContain("\x1b]8;;");
    expect(out).toContain("https://example.com");
    expect(out).toContain("Example");
  });

  it("replaces markdown links", () => {
    const md = "See [Grid](https://grid.example.com) for docs.";
    const out = replaceMarkdownLinksWithOsc8(md);
    expect(out).not.toContain("](https://");
    expect(out).toContain("Grid");
    expect(out).toContain("\x1b]8;;");
  });
});

describe("iTerm2 inline images", () => {
  it("emits File= inline sequence with url", () => {
    const seq = iterm2InlineImage("https://example.com/a.png", "diagram");
    expect(seq).toContain("1337;File=inline=1");
    expect(seq).toContain("url=https://example.com/a.png");
  });
});
