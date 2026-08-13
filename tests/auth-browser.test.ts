import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { findChromiumExecutable, resolveAuthBrowserMode } from "../src/auth/browser-isolated";
import { startBrowserCallbackServer, startCallbackServer } from "../src/auth/oauth";

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

describe("startCallbackServer", () => {
  it("offers alternative login methods when the callback port is occupied", async () => {
    const occupyingServer = createServer();
    await new Promise<void>((resolve, reject) => {
      occupyingServer.once("error", reject);
      occupyingServer.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = occupyingServer.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP listener");
      }

      const { ready } = startCallbackServer(address.port);
      await expect(ready).rejects.toThrow(
        new RegExp(
          `port ${address.port} is already in use[\\s\\S]+caipe auth login --device[\\s\\S]+caipe auth login --manual`,
        ),
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupyingServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("falls back to IPv6 loopback when the IPv4 callback is occupied", async () => {
    const occupyingServer = createServer();
    await new Promise<void>((resolve, reject) => {
      occupyingServer.once("error", reject);
      occupyingServer.listen(0, "127.0.0.1", resolve);
    });

    let callback: Awaited<ReturnType<typeof startBrowserCallbackServer>> | undefined;
    try {
      const address = occupyingServer.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP listener");
      }

      callback = await startBrowserCallbackServer(address.port);
      expect(callback.bindHost).toBe("::1");
      expect(callback.redirectUri).toBe(`http://localhost:${address.port}/callback`);
    } finally {
      callback?.close();
      await new Promise<void>((resolve, reject) => {
        occupyingServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
