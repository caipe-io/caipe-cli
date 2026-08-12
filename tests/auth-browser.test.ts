import { afterEach, describe, expect, it } from "vitest";
import { findChromiumExecutable, resolveAuthBrowserMode } from "../src/auth/browser-isolated";

describe("resolveAuthBrowserMode", () => {
  const prev = process.env.CAIPE_AUTH_BROWSER;

  afterEach(() => {
    if (prev === undefined) delete process.env.CAIPE_AUTH_BROWSER;
    else process.env.CAIPE_AUTH_BROWSER = prev;
  });

  it("defaults to isolated", () => {
    delete process.env.CAIPE_AUTH_BROWSER;
    expect(resolveAuthBrowserMode()).toBe("isolated");
  });

  it("respects CAIPE_AUTH_BROWSER=system", () => {
    process.env.CAIPE_AUTH_BROWSER = "system";
    expect(resolveAuthBrowserMode({ browser: "isolated" })).toBe("system");
  });

  it("respects explicit CLI browser option", () => {
    delete process.env.CAIPE_AUTH_BROWSER;
    expect(resolveAuthBrowserMode({ browser: "system" })).toBe("system");
  });
});

describe("findChromiumExecutable", () => {
  it("uses CAIPE_CHROMIUM_PATH when set", () => {
    const prev = process.env.CAIPE_CHROMIUM_PATH;
    process.env.CAIPE_CHROMIUM_PATH = process.execPath;
    try {
      expect(findChromiumExecutable()).toBe(process.execPath);
    } finally {
      if (prev === undefined) delete process.env.CAIPE_CHROMIUM_PATH;
      else process.env.CAIPE_CHROMIUM_PATH = prev;
    }
  });
});
