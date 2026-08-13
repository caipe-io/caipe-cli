import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const installer = readFileSync(new URL("../install.sh", import.meta.url), "utf8");

describe("release installer", () => {
  it("offers user-owned directories before the system-wide directory", () => {
    expect(installer).toContain('DEFAULT_INSTALL_DIR="${HOME}/.local/bin"');
    expect(installer).toContain('INSTALL_DIR="${CAIPE_INSTALL_DIR:-}"');
    expect(installer).toContain("Where should caipe be installed?");
    expect(installer).toContain('2) INSTALL_DIR="${HOME}/.bin"');
    expect(installer).toContain('3) INSTALL_DIR="/usr/local/bin"');
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
