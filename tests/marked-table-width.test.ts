import { describe, expect, it } from "vitest";
import { renderMarkdownToAnsi } from "../src/platform/terminal/ansi-markdown.js";
import {
  ansiFitsWidth,
  layoutTableColWidths,
  maxVisibleLineWidth,
  tableBorderSlack,
} from "../src/platform/terminal/marked-table-width.js";

describe("tableBorderSlack", () => {
  it("accounts for cli-table3 borders per column count", () => {
    expect(tableBorderSlack(2)).toBe(5);
    expect(tableBorderSlack(5)).toBe(8);
  });
});

describe("layoutTableColWidths", () => {
  it("sums column widths to the inner budget (content minus slack)", () => {
    const w = 100;
    for (const n of [2, 3, 5]) {
      const cols = layoutTableColWidths(n, w);
      expect(cols).toHaveLength(n);
      const inner = Math.max(n * 4, w - tableBorderSlack(n));
      expect(cols.reduce((a, b) => a + b, 0)).toBe(inner);
    }
  });

  it("uses a narrow # column for five-column PR grids", () => {
    const headers = ["#", "title", "author", "created", "labels"];
    const cols = layoutTableColWidths(5, 100, headers);
    expect(cols[0]).toBe(5);
    expect(cols[1]).toBeGreaterThanOrEqual(14);
  });

  it("allocates a wide link column for # | title | link tables", () => {
    const headers = ["#", "title", "link"];
    const cols = layoutTableColWidths(3, 72, headers);
    expect(cols[0]).toBe(5);
    expect(cols[2]).toBeGreaterThanOrEqual(16);
    expect(cols[2]).toBeGreaterThan(Number(cols[1]));
  });

  it("splits two-column tables path vs description", () => {
    const cols = layoutTableColWidths(2, 80);
    expect(cols[0]).toBeGreaterThanOrEqual(14);
    expect(cols[0]).toBeLessThanOrEqual(48);
  });
});

describe("maxVisibleLineWidth / ansiFitsWidth", () => {
  it("ignores ANSI escape sequences when measuring", () => {
    const text = "\x1b[31mhello\x1b[0m\nshort";
    expect(maxVisibleLineWidth(text)).toBe(5);
    expect(ansiFitsWidth(text, 5)).toBe(true);
    expect(ansiFitsWidth(text, 3)).toBe(false);
  });
});

describe("marked table integration", () => {
  const prTable = `| # | Title | Author | Created | Labels |
| --- | --- | --- | --- | --- |
| **#240** | fix(ui): picker | user@example.com | Jul 24 | ui |`;

  it.each([76, 100, 120])("PR table fits layout width %i", (layoutW) => {
    const ansi = renderMarkdownToAnsi(prTable, { width: layoutW, forceRich: true });
    expect(maxVisibleLineWidth(ansi)).toBeLessThanOrEqual(layoutW + 1);
  });
});
