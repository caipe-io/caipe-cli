/**
 * Assistant "Recap" lines — convention: leading `* Recap:` (or `Recap:`) on its own line.
 * Stripped from markdown body and shown as a dim recap row above the main reply.
 */

const RECAP_LINE = /^(?:\*+\s*)?Recap:\s*(.+)$/i;

/**
 * Extract an optional recap line from the start of assistant text (before first blank line block).
 */
export function extractRecap(source: string): { recap: string | null; body: string } {
  const trimmed = source.trimStart();
  if (!trimmed) return { recap: null, body: source };

  const lines = trimmed.split("\n");
  const first = lines[0]?.trim() ?? "";
  const match = RECAP_LINE.exec(first);
  if (!match) return { recap: null, body: source };

  const recap = match[1]?.trim() ?? "";
  const rest = lines.slice(1).join("\n").replace(/^\n+/, "");
  return { recap: recap || null, body: rest.trimStart() ? rest : "" };
}
