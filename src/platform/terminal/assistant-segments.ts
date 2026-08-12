import { isUnifiedDiffText } from "../diff.js";

export type AssistantSegment = { kind: "markdown"; text: string } | { kind: "diff"; text: string };

const FENCE_RE = /```([^\n]*)\n([\s\S]*?)```/g;

/** Split assistant markdown so diffs render as Ink widgets, not gray code blocks. */
export function splitAssistantSegments(source: string): AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  let lastIndex = 0;
  for (const match of source.matchAll(FENCE_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      pushMarkdown(segments, source.slice(lastIndex, index));
    }
    const lang = (match[1] ?? "").trim().toLowerCase();
    const body = (match[2] ?? "").trimEnd();
    if (lang === "diff" || isUnifiedDiffText(body)) {
      segments.push({ kind: "diff", text: body });
    } else {
      segments.push({ kind: "markdown", text: `\`\`\`${match[1] ?? ""}\n${body}\n\`\`\`` });
    }
    lastIndex = index + match[0].length;
  }
  if (lastIndex < source.length) {
    pushMarkdown(segments, source.slice(lastIndex));
  }
  if (segments.length === 0 && source.trim()) {
    if (isUnifiedDiffText(source.trim())) {
      segments.push({ kind: "diff", text: source.trim() });
    } else {
      segments.push({ kind: "markdown", text: source });
    }
  }
  return segments;
}

function pushMarkdown(segments: AssistantSegment[], raw: string): void {
  const text = raw.trim();
  if (!text) return;
  if (isUnifiedDiffText(text)) {
    segments.push({ kind: "diff", text });
    return;
  }
  segments.push({ kind: "markdown", text });
}
