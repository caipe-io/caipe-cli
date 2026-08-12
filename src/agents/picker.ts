import { pickerWindow } from "../chat/picker-nav.js";
import type { Agent } from "./types.js";

export { pickerWindow };

export function filterAgents(agents: Agent[], query: string): Agent[] {
  const q = query.trim().toLowerCase();
  if (!q) return agents;
  return agents.filter(
    (a) =>
      a.name.toLowerCase().includes(q) ||
      a.displayName.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q),
  );
}

/** Active agent first, then id ascending. */
export function sortAgentsForPicker(agents: Agent[], activeAgentName: string): Agent[] {
  return [...agents].sort((a, b) => {
    if (a.name === activeAgentName) return -1;
    if (b.name === activeAgentName) return 1;
    return a.name.localeCompare(b.name);
  });
}

export function truncateText(text: string, maxLen: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(0, maxLen - 1))}…`;
}
