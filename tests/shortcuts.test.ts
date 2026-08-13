import { describe, expect, it } from "vitest";
import { footerLayoutDirection } from "../src/chat/shortcuts.js";

describe("footerLayoutDirection", () => {
  it("stacks context below shortcuts in narrow terminals", () => {
    expect(footerLayoutDirection(80)).toBe("column");
    expect(footerLayoutDirection(99)).toBe("column");
  });

  it("uses one row when both sections fit", () => {
    expect(footerLayoutDirection(100)).toBe("row");
    expect(footerLayoutDirection(160)).toBe("row");
  });
});
