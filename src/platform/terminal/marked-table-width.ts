/**
 * GFM tables sized to the Ink content column (marked-terminal ignores width for tables).
 */

import chalk from "chalk";
import Table from "cli-table3";
import type { MarkedExtension, Parser, Tokens } from "marked";

function inlineCell(parser: Parser, cell: Tokens.TableCell): string {
  return parser.parseInline(cell.tokens).trim();
}

/** cli-table3 draws │ borders and cell padding beyond the sum of colWidths. */
export function tableBorderSlack(columnCount: number): number {
  return columnCount + 3;
}

function normalizeHeader(cell: Tokens.TableCell, parser: Parser): string {
  return inlineCell(parser, cell).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Split content width across columns (2-col: path + description; 5-col PR-style when headers match).
 */
export function layoutTableColWidths(
  columnCount: number,
  contentWidth: number,
  headers?: string[],
): number[] {
  const n = Math.max(1, columnCount);
  const slack = tableBorderSlack(n);
  const inner = Math.max(n * 4, contentWidth - slack);

  if (headers && headers.length === n) {
    const h = headers;
    const isPrGrid =
      n >= 4 &&
      h.some((c) => c === "#" || c.startsWith("#")) &&
      h.some((c) => c.includes("title")) &&
      h.some((c) => c.includes("author"));

    if (isPrGrid && n >= 5) {
      const num = 5;
      const created = Math.min(11, Math.max(8, Math.floor(inner * 0.1)));
      const author = Math.min(18, Math.max(10, Math.floor(inner * 0.16)));
      const labels = Math.min(16, Math.max(8, Math.floor(inner * 0.12)));
      const title = inner - num - created - author - labels;
      return [num, Math.max(14, title), author, created, labels];
    }

    if (n === 4 && isPrGrid) {
      const num = 5;
      const author = Math.min(16, Math.max(10, Math.floor(inner * 0.2)));
      const created = Math.min(11, Math.max(8, Math.floor(inner * 0.12)));
      const title = inner - num - author - created;
      return [num, Math.max(14, title), author, created];
    }

    const hasLinkCol = h.some((c) => c === "link" || c.includes("url"));
    if (n === 3 && h[0]?.startsWith("#") && hasLinkCol) {
      const num = 5;
      const title = Math.min(22, Math.max(10, Math.floor(inner * 0.22)));
      const link = inner - num - title;
      return [num, title, Math.max(16, link)];
    }
  }

  if (n === 1) return [inner];
  if (n === 2) {
    const first = Math.min(Math.max(14, Math.floor(inner * 0.34)), 48);
    return [first, Math.max(10, inner - first)];
  }

  const each = Math.max(6, Math.floor(inner / n));
  return Array.from({ length: n }, (_, i) =>
    i === n - 1 ? Math.max(6, inner - each * (n - 1)) : each,
  );
}

export function markedTableWidthExtension(contentWidth: number): MarkedExtension {
  const colBudget = Math.max(24, contentWidth);
  return {
    renderer: {
      table(token: Tokens.Table) {
        const cols = token.header.length;
        if (cols === 0) return "";
        const headers = token.header.map((cell) => normalizeHeader(cell, this.parser));
        const colWidths = layoutTableColWidths(cols, colBudget, headers);
        const head = token.header.map((cell) => inlineCell(this.parser, cell));
        const table = new Table({
          head,
          colWidths,
          wordWrap: true,
          wrapOnWordBoundary: true,
          style: { head: ["cyan", "bold"], border: ["gray"] },
        });
        for (const row of token.rows) {
          table.push(row.map((cell) => inlineCell(this.parser, cell)));
        }
        return `${chalk.reset(table.toString())}\n\n`;
      },
    },
  };
}

/** Longest visible line length (ignores ANSI escapes). */
export function maxVisibleLineWidth(text: string): number {
  const strip = text.replace(/\x1b\[[0-9;]*m/g, "");
  let max = 0;
  for (const line of strip.split("\n")) {
    max = Math.max(max, line.length);
  }
  return max;
}

/** True when every line fits the content column (optional +1 for rounding). */
export function ansiFitsWidth(text: string, contentWidth: number): boolean {
  return maxVisibleLineWidth(text) <= contentWidth + 1;
}
