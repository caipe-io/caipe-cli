/**
 * Session context assembler.
 *
 * Combines:
 *   - Memory files (global + project + managed)
 *   - Available agents from the server registry
 *   - Skills loaded in the supervisor
 *   - Git file tree (capped at 150 files)
 *   - Recent git log (last 20 commits)
 *
 * Total context is capped at 100k tokens (~400k chars).
 */
// assisted-by claude code claude-sonnet-4-6

import type { TokenSet } from "../auth/keychain.js";
import { buildMemoryContext, loadMemoryFiles } from "../memory/loader.js";
import { findRepoRoot, recentLog, sampleFileTree } from "../platform/git.js";

const MAX_CONTEXT_CHARS = 400_000; // ~100k tokens

export interface ClientUserContext {
  email?: string;
  name?: string;
  sub?: string;
}

export function clientUserFromTokenSet(tokens: TokenSet | null | undefined): ClientUserContext {
  if (!tokens) return {};
  const email = tokens.email ?? (tokens.identity?.includes("@") ? tokens.identity : undefined);
  const sub = tokens.identity && !tokens.identity.includes("@") ? tokens.identity : undefined;
  return {
    email,
    name: tokens.displayName,
    sub,
  };
}

/** Date + signed-in user for the agent (prepended to each turn). */
export function formatClientContextBlock(
  options: { now?: Date; user?: ClientUserContext } = {},
): string {
  const now = options.now ?? new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = now.toLocaleDateString("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const user = options.user ?? {};
  const lines = [
    "<client-context>",
    `Current local date: ${local}`,
    `Timezone: ${tz}`,
    `ISO-8601: ${now.toISOString()}`,
  ];
  if (user.email) lines.push(`User email: ${user.email}`);
  if (user.name) lines.push(`User name: ${user.name}`);
  if (user.sub) lines.push(`User id: ${user.sub}`);
  lines.push("</client-context>");
  return lines.join("\n");
}

/** @deprecated Use {@link formatClientContextBlock} */
export function formatClientDateContext(now = new Date()): string {
  return formatClientContextBlock({ now });
}

export interface ContextExtras {
  serverUrl?: string;
  getToken?: () => Promise<string>;
}

/**
 * Assemble the system context string for the session.
 * If `noContext` is true, only memory files are included (no git/agents/skills context).
 * Pass `extras` to enable progressive agent + skill injection.
 */
export async function buildSystemContext(
  cwd: string,
  noContext = false,
  extras: ContextExtras = {},
): Promise<string> {
  const memoryFiles = loadMemoryFiles(cwd);
  const memoryContext = buildMemoryContext(memoryFiles);
  const { loadTokens } = await import("../auth/keychain.js");
  const clock = formatClientContextBlock({
    user: clientUserFromTokenSet(await loadTokens()),
  });

  if (noContext) {
    return [clock, memoryContext].filter(Boolean).join("\n\n");
  }

  // Fetch agents + skills in parallel with git context — all best-effort
  const [repoRoot, agentsSection, skillsSection] = await Promise.all([
    findRepoRoot(cwd),
    extras.serverUrl && extras.getToken
      ? fetchAgentsSection(extras.serverUrl, extras.getToken)
      : Promise.resolve(""),
    extras.serverUrl && extras.getToken
      ? fetchSkillsSection(extras.serverUrl, extras.getToken)
      : Promise.resolve(""),
  ]);

  let gitSection = "";
  if (repoRoot !== null) {
    const [tree, log] = await Promise.all([sampleFileTree(repoRoot), recentLog(repoRoot)]);
    gitSection = `<repository>\n<root>${repoRoot}</root>\n<file-tree>\n${tree}\n</file-tree>\n<recent-commits>\n${log}\n</recent-commits>\n</repository>`;
  }

  const parts = [clock, memoryContext, agentsSection, skillsSection, gitSection].filter(Boolean);
  let combined = parts.join("\n\n");

  if (combined.length > MAX_CONTEXT_CHARS) {
    combined = `${combined.slice(0, MAX_CONTEXT_CHARS)}\n... (context truncated)`;
  }

  return combined;
}

// ---------------------------------------------------------------------------
// Internal helpers — best-effort, never throw
// ---------------------------------------------------------------------------

async function fetchAgentsSection(
  serverUrl: string,
  getToken: () => Promise<string>,
): Promise<string> {
  try {
    const { fetchAgents } = await import("../agents/registry.js");
    const agents = await fetchAgents(serverUrl, getToken);
    if (agents.length === 0) return "";
    const lines = agents
      .filter((a) => a.available)
      .map((a) => `- **${a.name}** (${a.domain}): ${a.description}`);
    return `<available-agents>\n${lines.join("\n")}\n</available-agents>`;
  } catch {
    return "";
  }
}

async function fetchSkillsSection(
  serverUrl: string,
  getToken: () => Promise<string>,
): Promise<string> {
  try {
    const { fetchSupervisorSkills } = await import("../skills/catalog.js");
    const { skills } = await fetchSupervisorSkills(getToken, serverUrl);
    if (skills.length === 0) return "";
    const lines = skills.map((s) => {
      const tags = s.metadata?.tags?.length ? ` [${s.metadata.tags.join(", ")}]` : "";
      return `- **${s.name}**${tags}: ${s.description}`;
    });
    return `<available-skills>\n${lines.join("\n")}\n</available-skills>`;
  } catch {
    return "";
  }
}
