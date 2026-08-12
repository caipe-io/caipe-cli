import { render } from "ink";
import React from "react";
import { describe, expect, it } from "vitest";
import { AnsiMarkdown } from "../src/platform/terminal/AnsiMarkdown.js";
import { renderMarkdownToAnsi } from "../src/platform/terminal/ansi-markdown.js";
import {
  maxVisibleLineWidth,
  tableBorderSlack,
} from "../src/platform/terminal/marked-table-width.js";

const GFM_LIST = "**Available agents**\n\n- **agent-sre** _(active)_ — SRE Agent";

describe("renderMarkdownToAnsi", () => {
  it("renders GFM tables as cli-table box (not raw pipe rows)", () => {
    const ansi = renderMarkdownToAnsi(
      `| Title | URL |
| --- | --- |
| CAIPE | https://wiki.example.com/display/COGNITIVE/CAIPE/overview/long/path |`,
      { width: 90, forceRich: true },
    );
    expect(ansi).toContain("┌");
    expect(ansi).not.toContain("mlink");
    expect(ansi).not.toMatch(/\x1b\]8;;[^\x1b]*link/i);
  });

  it("renders lists and headings without throwing in Ink", () => {
    expect(() => {
      render(
        React.createElement(AnsiMarkdown, {
          width: 80,
          // biome-ignore lint/correctness/noChildrenProp: AnsiMarkdownProps.children is typed `string`, not ReactNode, so createElement's variadic-children form doesn't type-check here.
          children: GFM_LIST,
        }),
      ).unmount();
    }).not.toThrow();
  });

  it("strips to plain text when NO_COLOR", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const out = renderMarkdownToAnsi("**bold**", { width: 80 });
      expect(out).toBe("bold");
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });

  it("does not truncate URLs inside markdown link hrefs in tables", () => {
    const long =
      "https://wiki.example.com/wiki/spaces/OPS/pages/123456789012345678901234567890/Title";
    const md = `| # | Title | Link |
| --- | --- | --- |
| 1 | Tome | [link](${long}) |`;
    const ansi = renderMarkdownToAnsi(md, { width: 72, forceRich: true });
    expect(ansi).toContain("wiki.example");
    expect(ansi).not.toContain("mlink");
  });

  it("renders GFM bullet lists with inline bold (marked v15)", () => {
    const md = "**Active Jira tasks:**\n\n* **OPENSD-2454** - Edge (Waiting)\n* **CFP-1** - foo";
    const ansi = renderMarkdownToAnsi(md, { width: 100, forceRich: true });
    expect(ansi).toContain("• OPENSD-2454");
    expect(ansi).not.toContain("**OPENSD");
    expect(ansi).not.toMatch(/^\s+\*/m);
  });

  it("keeps GFM tables within the layout width", () => {
    const layoutW = 76;
    const md = `| Path | What it is |
| --- | --- |
| ai_platform_engineering/agents/tome/README.md | Tome Agent - the LLM brain for the Tome wiki app, a Python service over HTTP/SSE |
| ui/src/lib/tome/ etc. | Core UI libs: tome-api.ts, tome-links.ts, audit.ts, guard.ts, page-store.ts, ingest-queue.ts |`;
    const ansi = renderMarkdownToAnsi(md, { width: layoutW, forceRich: true });
    expect(ansi).toContain("┌");
    expect(maxVisibleLineWidth(ansi)).toBeLessThanOrEqual(layoutW + 1);
  });

  it("keeps five-column PR tables within the layout width", () => {
    const layoutW = 100;
    const md = `| # | Title | Author | Created | Labels |
| --- | --- | --- | --- | --- |
| **#240** | fix(ui): add agent picker | sriaradhyula | Jul 24 | bug, ui |
| **#237** | feat(ui): stream chat | juliarvalenti | Jul 20 | enhancement |`;
    const ansi = renderMarkdownToAnsi(md, { width: layoutW, forceRich: true });
    expect(maxVisibleLineWidth(ansi)).toBeLessThanOrEqual(layoutW + 1);
    expect(tableBorderSlack(5)).toBeGreaterThan(0);
  });
});
