import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const installer = readFileSync(new URL("../install.sh", import.meta.url), "utf8");

describe("release installer", () => {
  it("installs the launcher in a user-owned directory by default", () => {
    expect(installer).toContain('INSTALL_DIR="${CAIPE_INSTALL_DIR:-${HOME}/.local/bin}"');
    expect(installer).not.toContain("CAIPE_INSTALL_DIR:-/usr/local/bin");
  });

  it("uses the API-free latest-release redirect by default", () => {
    expect(installer).toContain('DEFAULT_VERSION="latest"');
    expect(installer).toContain('BASE_URL="https://github.com/${REPO}/releases/latest/download"');
    expect(installer).not.toContain("api.github.com");
  });

  it("keeps explicit version pins on immutable release URLs", () => {
    expect(installer).toContain('BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"');
  });
});
