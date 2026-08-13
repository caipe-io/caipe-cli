import { afterEach, describe, expect, it } from "vitest";
import { isUnifiedDiffText, renderDiff } from "../src/platform/diff.js";

describe("isUnifiedDiffText", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("detects unified diff headers", () => {
    const raw = "--- a\n+++ b\n-old\n+new";
    expect(isUnifiedDiffText(raw)).toBe(true);
  });

  it("detects ANSI-colored rendered diffs", () => {
    delete process.env.NO_COLOR;
    const rendered = renderDiff("old\n", "new\n", "example.txt");

    expect(rendered).toContain("\x1b[");
    expect(isUnifiedDiffText(rendered)).toBe(true);
  });
});
