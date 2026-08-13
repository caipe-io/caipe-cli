/** Global REPL shortcuts (labels only — handling lives in Repl / InputBar). */

/** Open interactive agent picker (same as `/agents` with no argument). */
export const SHORTCUT_AGENT_PICKER = "Ctrl+O";

/** Open slash command menu (type at start of line). */
export const SHORTCUT_SLASH_COMMANDS = "/";

export const FOOTER_HINT_IDLE = `${SHORTCUT_SLASH_COMMANDS} commands · ${SHORTCUT_AGENT_PICKER} agents · Ctrl+D exit`;

export const PICKER_HINT_NAV = "↑↓ · PgUp/PgDn · Tab · Enter · Esc";

/** Prevent the shortcut and context sections from colliding in narrow terminals. */
export function footerLayoutDirection(columns: number): "column" | "row" {
  return columns < 100 ? "column" : "row";
}
