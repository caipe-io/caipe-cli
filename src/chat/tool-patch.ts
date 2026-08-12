/**
 * Extract unified diffs from AG-UI tool args / TOOL_CALL_RESULT content for InkDiffBlock.
 */

import { isUnifiedDiffText, renderDiff } from "../platform/diff.js";

export interface ToolPatch {
  path?: string;
  unifiedDiff: string;
}

const FILE_TOOL_NAME =
  /write|edit|patch|update|replace|str_replace|insert|create|apply|file|notebook/i;

function isFileToolName(name: string): boolean {
  return FILE_TOOL_NAME.test(name.replace(/[^a-zA-Z0-9_]/g, "_"));
}

function readPath(obj: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file_path", "filePath", "filename", "file"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function readOldNew(obj: Record<string, unknown>): { oldText: string; newText: string } | null {
  const oldKeys = ["old_string", "oldString", "old_text", "oldText", "original", "before"];
  const newKeys = [
    "new_string",
    "newString",
    "new_text",
    "newText",
    "replacement",
    "after",
    "content",
  ];
  let oldText: string | undefined;
  let newText: string | undefined;
  for (const k of oldKeys) {
    const v = obj[k];
    if (typeof v === "string") {
      oldText = v;
      break;
    }
  }
  for (const k of newKeys) {
    const v = obj[k];
    if (typeof v === "string") {
      newText = v;
      break;
    }
  }
  if (oldText === undefined && newText === undefined) return null;
  return { oldText: oldText ?? "", newText: newText ?? "" };
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function unwrapResultEnvelope(obj: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["result", "data", "output", "value", "payload"]) {
    const inner = obj[key];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return inner as Record<string, unknown>;
    }
    if (typeof inner === "string") {
      const nested = parseJsonRecord(inner);
      if (nested) return nested;
    }
  }
  return obj;
}

function patchFromUnifiedField(obj: Record<string, unknown>): ToolPatch | null {
  for (const key of ["patch", "diff", "unified_diff", "unifiedDiff", "unified", "hunk"]) {
    const v = obj[key];
    if (typeof v === "string" && isUnifiedDiffText(v.trim())) {
      return { path: readPath(obj), unifiedDiff: v.trim() };
    }
  }
  return null;
}

function patchFromOldNew(obj: Record<string, unknown>, label: string): ToolPatch | null {
  const pair = readOldNew(obj);
  if (!pair) return null;
  if (pair.oldText === pair.newText) return null;
  const path = readPath(obj) ?? label;
  return { path, unifiedDiff: renderDiff(pair.oldText, pair.newText, path) };
}

/** Build a diff from streaming tool-call JSON args (TOOL_CALL_ARGS buffer). */
export function patchFromToolArgs(toolName: string, argsJson: string): ToolPatch | null {
  if (!isFileToolName(toolName)) return null;
  const obj = parseJsonRecord(argsJson);
  if (!obj) return null;
  const path = readPath(obj);
  const fromPatch = patchFromUnifiedField(obj);
  if (fromPatch) return fromPatch;
  const fromOldNew = patchFromOldNew(obj, path ?? toolName);
  if (fromOldNew) return fromOldNew;
  return null;
}

/** Build a diff from AG-UI TOOL_CALL_RESULT `content` string. */
export function patchFromToolResult(toolName: string, content: string): ToolPatch | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  if (isUnifiedDiffText(trimmed)) {
    return { unifiedDiff: trimmed };
  }

  const obj = parseJsonRecord(trimmed);
  if (!obj) {
    if (isFileToolName(toolName) && trimmed.includes("\n-") && trimmed.includes("\n+")) {
      return { unifiedDiff: trimmed };
    }
    return null;
  }

  const root = unwrapResultEnvelope(obj);
  const path = readPath(root) ?? readPath(obj);

  const fromPatch = patchFromUnifiedField(root) ?? patchFromUnifiedField(obj);
  if (fromPatch) {
    return { path: fromPatch.path ?? path, unifiedDiff: fromPatch.unifiedDiff };
  }

  const fromOldNew =
    patchFromOldNew(root, path ?? toolName) ?? patchFromOldNew(obj, path ?? toolName);
  if (fromOldNew) return fromOldNew;

  if (isFileToolName(toolName)) {
    for (const key of ["message", "summary", "status"]) {
      const v = root[key];
      if (typeof v === "string" && isUnifiedDiffText(v.trim())) {
        return { path, unifiedDiff: v.trim() };
      }
    }
  }

  return null;
}

/** Prefer result payload; fall back to accumulated args. */
export function patchFromToolCall(
  toolName: string,
  argsJson: string | undefined,
  resultContent: string | undefined,
): ToolPatch | null {
  if (resultContent?.trim()) {
    const fromResult = patchFromToolResult(toolName, resultContent);
    if (fromResult) return fromResult;
  }
  if (argsJson?.trim()) {
    return patchFromToolArgs(toolName, argsJson);
  }
  return null;
}
