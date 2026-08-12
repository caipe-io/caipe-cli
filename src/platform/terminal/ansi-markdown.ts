/**
 * Markdown → ANSI for Ink {@link Text} (marked + marked-terminal).
 *
 * Used after a turn completes (no streaming). Tables use cli-table3; text reflows to width.
 */

import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

import {
  getTerminalCapabilities,
  getTerminalWidth,
  isRichTerminalEnabled,
} from "./capabilities.js";
import { markedListInlineExtension } from "./marked-list-fix.js";
import { markedTableWidthExtension } from "./marked-table-width.js";
import { plainTextFromMarkdown } from "./plain-markdown.js";

export interface RenderMarkdownToAnsiOptions {
  width?: number;
  osc8Links?: boolean;
  /** Render ANSI even when stdout is not a TTY (tests). */
  forceRich?: boolean;
}

const MD_LINK_PLACEHOLDER = /\x00MDLINK(\d+)\x00/g;

/** marked-terminal renders links (OSC 8 when supported). Do not pre-inject OSC sequences. */
function preprocessSource(source: string): string {
  return sanitizeMarkdownLinkHrefs(shortenTableUrls(source));
}

/** Drop markdown links whose href is not a safe http(s) URL (avoids OSC 8 opening garbage). */
function sanitizeMarkdownLinkHrefs(source: string): string {
  return source.replace(
    /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (full, label: string, href: string) => {
      const h = href.trim();
      if (isHttpUrl(h)) return full;
      if (label && h && label !== h) return `${label} (${h})`;
      return label || h || full;
    },
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Shorten bare URL text in table rows; never mutate URLs inside `[label](url)` hrefs. */
function shortenTableUrls(source: string, maxLen = 56): string {
  return source
    .split("\n")
    .map((line) => {
      if (!line.trim().startsWith("|")) return line;
      const protectedLinks: string[] = [];
      const masked = line.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (link) => {
        const id = protectedLinks.length;
        protectedLinks.push(link);
        return `\x00MDLINK${id}\x00`;
      });
      const shortened = masked.replace(/https?:\/\/[^\s|)]+/g, (url) =>
        shortenUrlForDisplay(url, maxLen),
      );
      return shortened.replace(
        MD_LINK_PLACEHOLDER,
        (_, id: string) => protectedLinks[Number(id)] ?? "",
      );
    })
    .join("\n");
}

function shortenUrlForDisplay(url: string, maxLen: number): string {
  if (url.length <= maxLen) return url;
  try {
    const u = new URL(url);
    const short = `${u.hostname}${u.pathname !== "/" ? u.pathname : ""}`;
    return short.length > maxLen ? `${short.slice(0, maxLen - 1)}…` : short;
  } catch {
    return `${url.slice(0, maxLen - 1)}…`;
  }
}

function createMarked(width: number): Marked {
  const contentWidth = Math.max(20, width);
  const instance = new Marked({ gfm: true, breaks: false });
  instance.use(
    markedTerminal({
      width: contentWidth,
      reflowText: true,
      showSectionPrefix: false,
      tableOptions: {
        wordWrap: true,
        wrapOnWordBoundary: true,
      },
    }),
  );
  instance.use(markedListInlineExtension());
  instance.use(markedTableWidthExtension(contentWidth));
  return instance;
}

/** Render markdown to an ANSI string safe for Ink `Text wrap="wrap"`. */
export function renderMarkdownToAnsi(
  source: string,
  options: RenderMarkdownToAnsiOptions = {},
): string {
  const trimmed = source.trimEnd();
  if (!trimmed) return "";

  if (!options.forceRich && !isRichTerminalEnabled()) {
    return plainTextFromMarkdown(trimmed);
  }

  const caps = getTerminalCapabilities();
  const width = options.width ?? caps.width ?? getTerminalWidth();
  const input = preprocessSource(trimmed);
  const marked = createMarked(Math.max(20, width));

  const wantOsc8 = options.osc8Links ?? (process.env.CAIPE_HYPERLINKS === "1" && caps.osc8Links);
  const prevForce = process.env.FORCE_HYPERLINK;
  if (!wantOsc8) process.env.FORCE_HYPERLINK = "0";

  let out: string | Promise<string>;
  try {
    out = marked.parse(input);
  } finally {
    if (!wantOsc8) {
      if (prevForce === undefined) delete process.env.FORCE_HYPERLINK;
      else process.env.FORCE_HYPERLINK = prevForce;
    }
  }

  return typeof out === "string" ? out.trimEnd() : plainTextFromMarkdown(trimmed);
}

export { plainTextFromMarkdown };
