/**
 * Unified diff as Ink lines (Claude Code–style gutter + line backgrounds).
 */

import { Box, Text } from "ink";
import type React from "react";
import { useMemo } from "react";

import { isRichTerminalEnabled } from "./capabilities.js";

export interface InkDiffBlockProps {
  text: string;
  width: number;
}

type DiffLineKind = "add" | "del" | "meta" | "context";

interface ParsedDiffLine {
  kind: DiffLineKind;
  display: string;
  oldNum: number | null;
  newNum: number | null;
}

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { oldStart: Number.parseInt(m[1] ?? "0", 10), newStart: Number.parseInt(m[2] ?? "0", 10) };
}

function parseDiffLines(text: string): ParsedDiffLine[] {
  const out: ParsedDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of text.split("\n")) {
    const line = raw.length === 0 ? " " : raw;
    if (line.startsWith("@@")) {
      const hunk = parseHunkHeader(line);
      if (hunk) {
        oldLine = hunk.oldStart;
        newLine = hunk.newStart;
      }
      out.push({ kind: "meta", display: line, oldNum: null, newNum: null });
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++")) {
      out.push({ kind: "meta", display: line, oldNum: null, newNum: null });
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      out.push({ kind: "add", display: line, oldNum: null, newNum: newLine });
      newLine++;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      out.push({ kind: "del", display: line, oldNum: oldLine, newNum: null });
      oldLine++;
      continue;
    }
    const body = line.startsWith(" ") ? line : ` ${line}`;
    out.push({ kind: "context", display: body, oldNum: oldLine, newNum: newLine });
    oldLine++;
    newLine++;
  }
  return out;
}

function gutterCell(n: number | null): string {
  if (n == null) return "    ";
  return String(n).padStart(4, " ");
}

export function InkDiffBlock({ text, width }: InkDiffBlockProps): React.ReactElement {
  const rich = isRichTerminalEnabled();
  const lines = useMemo(() => parseDiffLines(text), [text]);

  return (
    <Box flexDirection="column" width={width} marginY={0}>
      {lines.map((row, index) => {
        const bg =
          rich && row.kind === "add" ? "green" : rich && row.kind === "del" ? "red" : undefined;
        const fg =
          row.kind === "add"
            ? rich
              ? "white"
              : undefined
            : row.kind === "del"
              ? rich
                ? "white"
                : undefined
              : undefined;

        return (
          // ink 5 has no Box-level background; the row tint lives on the Text nodes.
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are a fixed re-parse of one diff's text, never reordered or spliced.
          <Box key={index} flexDirection="row">
            <Text backgroundColor={bg} dimColor={row.kind === "meta"}>
              {gutterCell(row.oldNum)}
              {row.kind === "add" || row.kind === "context" ? gutterCell(row.newNum) : "    "}
            </Text>
            <Text
              backgroundColor={bg}
              color={fg}
              dimColor={row.kind === "meta"}
              wrap="truncate-end"
            >
              {row.display}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
