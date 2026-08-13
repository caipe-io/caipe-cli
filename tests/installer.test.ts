import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const installer = readFileSync(new URL("../install.sh", import.meta.url), "utf8");

describe("release installer", () => {
  it("uses the API-free latest-release redirect by default", () => {
    expect(installer).toContain('DEFAULT_VERSION="latest"');
    expect(installer).toContain('BASE_URL="https://github.com/${REPO}/releases/latest/download"');
    expect(installer).not.toContain("api.github.com");
  });

  it("keeps explicit version pins on immutable release URLs", () => {
    expect(installer).toContain('BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"');
  });
});
