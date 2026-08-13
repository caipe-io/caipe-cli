/**
 * Unified diff helper for skill update previews.
 *
 * Uses the `diff` npm package to produce a unified diff and colorizes it
 * with ANSI escape codes (green = added, red = removed, grey = context).
 * All color output is suppressed when NO_COLOR is set.
 */

import { createTwoFilesPatch } from "diff";

function diffColors(): { green: string; red: string; grey: string; reset: string } {
  if (process.env.NO_COLOR) {
    return { green: "", red: "", grey: "", reset: "" };
  }
  return {
    green: "\x1b[32m",
    red: "\x1b[31m",
    grey: "\x1b[90m",
    reset: "\x1b[0m",
  };
}

/**
 * Render a colored unified diff between `oldText` and `newText`.
 * `label` is used as the file name in the diff header.
 */
export function renderDiff(oldText: string, newText: string, label: string): string {
  const patch = createTwoFilesPatch(
    `${label} (current)`,
    `${label} (new)`,
    oldText,
    newText,
    "",
    "",
    { context: 3 },
  );

  const lines = patch.split("\n");
  const { green, red, grey, reset } = diffColors();
  const colored = lines.map((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return `${green}${line}${reset}`;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return `${red}${line}${reset}`;
    }
    if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) {
      return `${grey}${line}${reset}`;
    }
    return line;
  });

  return colored.join("\n");
}

/** Heuristic: unified diff hunk (---/+++/@@ or many +/- lines). */
export function isUnifiedDiffText(text: string): boolean {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const hasHeader =
    lines.some((l) => l.startsWith("--- ")) && lines.some((l) => l.startsWith("+++ "));
  const hasHunk = lines.some((l) => l.startsWith("@@"));
  if (hasHeader || (hasHunk && lines.some((l) => l.startsWith("+") || l.startsWith("-")))) {
    return true;
  }
  const changeLines = lines.filter(
    (l) =>
      (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---")),
  );
  return changeLines.length >= 6 && lines.some((l) => l.startsWith("@@"));
}

/** Color +/- and hunk headers in diff text already present in the stream. */
export function colorizeUnifiedDiffText(text: string): string {
  if (process.env.NO_COLOR) return text;
  const { green, red, grey, reset } = diffColors();
  const lines = text.split("\n");
  return lines
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        return `${green}${line}${reset}`;
      }
      if (line.startsWith("-") && !line.startsWith("---")) {
        return `${red}${line}${reset}`;
      }
      if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) {
        return `${grey}${line}${reset}`;
      }
      return line;
    })
    .join("\n");
}
