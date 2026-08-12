/**
 * Incremental markdown streaming: stable blocks + active tail (last block only repaints).
 */

import { isUnifiedDiffText } from "../platform/diff.js";
import { getMarkdownLayoutWidth } from "../platform/markdown.js";

export interface MarkdownPartition {
  stableBlocks: string[];
  tailBlock: string;
}

/**
 * Split markdown into completed blocks (blank-line separated, respecting fenced code)
 * and a trailing incomplete block.
 */
export function partitionMarkdown(source: string): MarkdownPartition {
  if (!source) {
    return { stableBlocks: [], tailBlock: "" };
  }

  const lines = source.split("\n");
  const stableBlocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  for (const line of lines) {
    const fence = line.match(/^(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1] ?? "";
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (line.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
      }
    }

    if (!inFence && line.trim() === "" && current.length > 0) {
      const text = current.join("\n").trimEnd();
      if (text) stableBlocks.push(text);
      current = [];
      continue;
    }

    current.push(line);
  }

  return { stableBlocks, tailBlock: current.join("\n") };
}

/** Close an unterminated fenced code block for preview parsing. */
export function remendMarkdownTail(tail: string): string {
  if (!tail) return tail;
  const backticks = (tail.match(/```/g) || []).length;
  if (backticks % 2 === 1) {
    return `${tail}\n\`\`\``;
  }
  const tildes = (tail.match(/~~~/g) || []).length;
  if (tildes % 2 === 1) {
    return `${tail}\n~~~`;
  }
  return tail;
}

export function isDiffBlock(raw: string): boolean {
  return isUnifiedDiffText(raw.trim());
}

export interface StreamDisplay {
  frozenDisplay: string;
  tailDisplay: string;
  fullDynamicDisplay: string;
}

/**
 * Tracks stable block cache; tail is re-rendered in Ink on each sync().
 */
export class MarkdownStreamSession {
  private stableBlockTexts: string[] = [];
  private drainedStableCount = 0;
  private layoutWidth = getMarkdownLayoutWidth("assistant");

  reset(): void {
    this.stableBlockTexts = [];
    this.drainedStableCount = 0;
    this.layoutWidth = getMarkdownLayoutWidth("assistant");
  }

  /** Raw stable blocks not yet appended to Ink Static. */
  drainNewStableBlocks(): string[] {
    const pending = this.stableBlockTexts.slice(this.drainedStableCount);
    this.drainedStableCount = this.stableBlockTexts.length;
    return pending;
  }

  /** @deprecated use drainNewStableBlocks */
  drainNewRenderedBlocks(): string[] {
    return this.drainNewStableBlocks();
  }

  sync(fullText: string, layoutWidth?: number): StreamDisplay {
    const width = layoutWidth ?? getMarkdownLayoutWidth("assistant");
    if (width !== this.layoutWidth) {
      this.stableBlockTexts = [];
      this.drainedStableCount = 0;
      this.layoutWidth = width;
    }

    const { stableBlocks, tailBlock } = partitionMarkdown(fullText);

    while (this.stableBlockTexts.length < stableBlocks.length) {
      const idx = this.stableBlockTexts.length;
      this.stableBlockTexts.push(stableBlocks[idx] ?? "");
    }

    const tailDisplay = tailBlock ? remendMarkdownTail(tailBlock) : "";
    const frozenDisplay = this.stableBlockTexts.filter(Boolean).join("\n\n");
    const fullDynamicDisplay = frozenDisplay
      ? tailDisplay
        ? `${frozenDisplay}\n\n${tailDisplay}`
        : frozenDisplay
      : tailDisplay;

    return { frozenDisplay, tailDisplay, fullDynamicDisplay };
  }
}

export function streamPlainTextEnabled(): boolean {
  return process.env.CAIPE_STREAM_PLAIN === "1";
}
