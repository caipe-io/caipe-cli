import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ReleaseInfo,
  checksumForAsset,
  downloadVerifiedBinary,
  fetchLatestRelease,
  installBinaryAtomically,
  isUpdateAvailable,
  normalizeReleaseVersion,
  platformAssetName,
  resolveInstallTarget,
  sha256,
} from "../src/update/service";
import { updateCheckIsDue } from "../src/update/startup";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function release(assets: ReleaseInfo["assets"] = []): ReleaseInfo {
  return {
    version: "1.2.0",
    tag: "v1.2.0",
    url: "https://example.com/releases/1.2.0",
    assets,
  };
}

describe("release discovery", () => {
  it("normalizes supported tag formats and compares versions", () => {
    expect(normalizeReleaseVersion("caipe/v1.2.3")).toBe("1.2.3");
    expect(normalizeReleaseVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeReleaseVersion("not-a-version")).toBeNull();
    expect(isUpdateAvailable("1.1.9", "1.2.0")).toBe(true);
    expect(isUpdateAvailable("1.2.0", "1.2.0")).toBe(false);
  });

  it("maps supported platforms to release asset names", () => {
    expect(platformAssetName("darwin", "arm64")).toBe("caipe-darwin-arm64");
    expect(platformAssetName("linux", "x64")).toBe("caipe-linux-x64");
    expect(platformAssetName("win32", "x64")).toBeNull();
  });

  it("parses a stable GitHub release payload", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          tag_name: "v1.2.0",
          html_url: "https://example.com/releases/1.2.0",
          draft: false,
          prerelease: false,
          assets: [
            {
              name: "caipe-linux-x64",
              browser_download_url: "https://example.com/caipe-linux-x64",
              size: 4,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const found = await fetchLatestRelease(fetchImpl, "https://api.example.com/releases/latest");
    expect(found.version).toBe("1.2.0");
    expect(found.assets[0]?.name).toBe("caipe-linux-x64");
  });
});

describe("verified update downloads", () => {
  it("accepts a binary only when its published checksum matches", async () => {
    const binary = new TextEncoder().encode("safe-binary");
    const checksums = new TextEncoder().encode(`${sha256(binary)}  caipe-linux-x64\n`);
    const info = release([
      {
        name: "caipe-linux-x64",
        browserDownloadUrl: "https://example.com/caipe-linux-x64",
        size: binary.byteLength,
      },
      {
        name: "caipe-checksums.txt",
        browserDownloadUrl: "https://example.com/caipe-checksums.txt",
        size: checksums.byteLength,
      },
    ]);
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.endsWith("checksums.txt") ? checksums : binary;
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    await expect(downloadVerifiedBinary(info, fetchImpl, "caipe-linux-x64")).resolves.toEqual(
      binary,
    );
    expect(checksumForAsset(new TextDecoder().decode(checksums), "caipe-linux-x64")).toBe(
      sha256(binary),
    );
  });

  it("rejects a checksum mismatch", async () => {
    const binary = new TextEncoder().encode("tampered");
    const checksums = new TextEncoder().encode(`${"0".repeat(64)}  caipe-linux-x64\n`);
    const info = release([
      {
        name: "caipe-linux-x64",
        browserDownloadUrl: "https://example.com/caipe-linux-x64",
        size: binary.byteLength,
      },
      {
        name: "caipe-checksums.txt",
        browserDownloadUrl: "https://example.com/caipe-checksums.txt",
        size: checksums.byteLength,
      },
    ]);
    const fetchImpl = (async (input: string | URL | Request) =>
      new Response(String(input).endsWith("checksums.txt") ? checksums : binary, {
        status: 200,
      })) as typeof fetch;

    await expect(downloadVerifiedBinary(info, fetchImpl, "caipe-linux-x64")).rejects.toThrow(
      /checksum verification failed/i,
    );
  });
});

describe("installation", () => {
  it("smoke-tests and atomically replaces the current binary", () => {
    const dir = mkdtempSync(join(tmpdir(), "caipe-update-"));
    cleanup.push(dir);
    const target = join(dir, "caipe");
    writeFileSync(target, "old");
    const next = new TextEncoder().encode("new");

    installBinaryAtomically(target, next, "1.2.0", (candidate, expectedVersion) => {
      expect(readFileSync(candidate, "utf8")).toBe("new");
      expect(expectedVersion).toBe("1.2.0");
    });

    expect(readFileSync(target, "utf8")).toBe("new");
    expect(existsSync(target)).toBe(true);
  });

  it("distinguishes npm, known binary, and source installs", () => {
    expect(
      resolveInstallTarget({
        env: { CAIPE_INSTALL_METHOD: "npm" },
        execPath: "/usr/bin/node",
        isBun: false,
      }),
    ).toEqual({ kind: "npm" });
    expect(
      resolveInstallTarget({
        env: { CAIPE_BINARY_PATH: "/opt/caipe/caipe-linux-x64" },
        execPath: "/usr/bin/node",
        isBun: false,
      }),
    ).toEqual({ kind: "binary", path: "/opt/caipe/caipe-linux-x64" });
    expect(resolveInstallTarget({ env: {}, execPath: "/usr/bin/node", isBun: false }).kind).toBe(
      "unsupported",
    );
  });
});

describe("startup update cadence", () => {
  it("checks at most once per day", () => {
    const now = Date.parse("2026-08-13T12:00:00Z");
    expect(updateCheckIsDue({}, now)).toBe(true);
    expect(updateCheckIsDue({ lastCheckedAt: "2026-08-13T11:00:00Z" }, now)).toBe(false);
    expect(updateCheckIsDue({ lastCheckedAt: "2026-08-12T11:00:00Z" }, now)).toBe(true);
  });
});
