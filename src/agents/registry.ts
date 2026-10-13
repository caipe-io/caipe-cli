/**
 * CAIPE server agent registry client.
 *
 * Fetches agents from GET <serverUrl>/api/user/accessible-agents.
 * Cache: ~/.config/caipe/agents-cache.json (5-minute TTL).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  agentsCachePath,
  authEndpoints,
  getConfiguredDefaultAgent,
  globalConfigDir,
} from "../platform/config.js";
import type { Agent } from "./types.js";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;

interface CachedAgents {
  agents: Agent[];
  cachedAt: string;
  serverUrl: string;
  credentialFingerprint: string;
}

interface AgentPickerEntry {
  id: string;
  name: string;
  description: string;
}

interface AgentPickerResponse {
  success: boolean;
  data?: {
    agents: AgentPickerEntry[];
    total?: number;
    page?: number;
    page_size?: number;
  };
}

export interface ValidationResult {
  valid: boolean;
  supported: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the list of available agents from the CAIPE server.
 * Uses 5-minute cache; stale cache returned on network error.
 */
export async function fetchAgents(
  serverUrl: string,
  getToken: () => Promise<string>,
  options: { fresh?: boolean } = {},
): Promise<Agent[]> {
  // A shared host may use different company/user connections. Never reuse a
  // catalog across credentials, including legacy caches without a binding.
  const token = await getToken();
  const fingerprint = createHash("sha256").update(token).digest("hex");
  const cached = readCache(serverUrl, fingerprint);
  if (!options.fresh && cached && Date.now() - Date.parse(cached.cachedAt) < CACHE_TTL_MS) {
    return cached.agents;
  }

  try {
    const ep = authEndpoints(serverUrl);
    const pickerEntries = await fetchAllAgentPages(ep.agents, token, options.fresh === true);
    const agents: Agent[] = pickerEntries.map((e) => ({
      name: e.id,
      displayName: e.name || e.id,
      description: typeof e.description === "string" ? e.description : "",
      endpoint: "",
      protocols: ["agui"],
      available: true,
      domain: "general",
    }));
    writeCache(serverUrl, fingerprint, agents);
    return agents;
  } catch (err) {
    if (err instanceof RegistryAccessDenied && cached) {
      rmSync(agentsCachePath(), { force: true });
    }
    if (!options.fresh && cached && !(err instanceof RegistryAccessDenied)) {
      process.stderr.write(
        `[WARNING] Could not reach agents registry (${String(err)}). Using cached list.\n`,
      );
      return cached.agents;
    }
    throw new Error(`Agents registry unavailable: ${String(err)}`);
  }
}

class RegistryAccessDenied extends Error {}

async function fetchAllAgentPages(
  endpoint: string,
  token: string,
  requirePagination: boolean,
): Promise<AgentPickerEntry[]> {
  const entries: AgentPickerEntry[] = [];
  const ids = new Set<string>();
  let snapshotTotal: number | undefined;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(endpoint);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(PAGE_SIZE));

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const ErrorType = [401, 403].includes(res.status) ? RegistryAccessDenied : Error;
      throw new ErrorType(`HTTP ${res.status}`);
    }

    const body = (await res.json()) as AgentPickerResponse;
    if (body.success !== true || !Array.isArray(body.data?.agents)) {
      throw new Error("Agents registry returned an invalid catalog response");
    }
    const pageEntries = body.data.agents;
    const total = body.data?.total;
    if (requirePagination && total === undefined) {
      throw new Error("Fresh agent discovery requires a complete paginated registry snapshot");
    }
    if (total !== undefined && (!Number.isSafeInteger(total) || total < 0)) {
      throw new Error("Agents registry returned invalid pagination metadata");
    }
    if (snapshotTotal !== undefined && total !== snapshotTotal) {
      throw new Error("Agents registry changed during pagination; retry discovery");
    }
    snapshotTotal ??= total;
    if (body.data.page !== undefined && body.data.page !== page) {
      throw new Error("Agents registry returned an unexpected page");
    }
    for (const entry of pageEntries) {
      if (
        !entry ||
        typeof entry.id !== "string" ||
        !entry.id.trim() ||
        entry.id.trim() !== entry.id ||
        entry.id.includes("\0") ||
        typeof entry.name !== "string"
      ) {
        throw new Error("Agents registry returned an invalid agent reference");
      }
      if (ids.has(entry.id)) throw new Error("Agents registry repeated an agent across pages");
      ids.add(entry.id);
    }
    if (typeof total === "number" && entries.length + pageEntries.length > total) {
      throw new Error("Agents registry returned more agents than its reported total");
    }
    entries.push(...pageEntries);

    // Older servers may omit pagination metadata. In that case, preserve the
    // legacy single-page behavior instead of issuing speculative requests.
    if (typeof total !== "number" || entries.length >= total) {
      return entries;
    }

    if (pageEntries.length === 0) {
      throw new Error(
        `Agents registry pagination stopped after ${entries.length} of ${total} agents`,
      );
    }
  }

  throw new Error(`Agents registry exceeded ${MAX_PAGES} pages`);
}

/**
 * Find an agent by slug (name) or display name (case-insensitive).
 */
export function getAgent(agents: Agent[], name: string): Agent | null {
  const lower = name.toLowerCase();
  return (
    agents.find((a) => a.name === name) ??
    agents.find((a) => a.displayName.toLowerCase() === lower) ??
    null
  );
}

/** Sentinel CLI flag value — not a server agent id. */
export function isAutoAgentName(name: string | undefined): boolean {
  if (!name || name.trim() === "") return true;
  return name.trim().toLowerCase() === "default";
}

/**
 * Pick an agent from a fetched list (pure — used by resolveSessionAgent and tests).
 *
 * Priority when auto:
 *   configured default (settings / CAIPE_DEFAULT_AGENT) → first available → any
 */
export function pickSessionAgent(
  agents: Agent[],
  requestedName?: string,
  configuredDefault?: string,
): Agent {
  if (agents.length === 0) {
    throw new Error(
      "No agents returned for your account. Ask an admin to grant agent#use on a dynamic agent, then run `caipe agents list`.",
    );
  }

  if (!isAutoAgentName(requestedName)) {
    const found = getAgent(agents, requestedName!.trim());
    if (found) return found;
    const ids = agents.map((a) => a.name).join(", ");
    throw new Error(
      `Agent "${requestedName}" not found. Run \`caipe agents list\`. Accessible ids: ${ids}`,
    );
  }

  if (configuredDefault) {
    const preferred = getAgent(agents, configuredDefault);
    if (preferred) {
      return preferred;
    }
    process.stderr.write(
      `[WARNING] Configured default agent "${configuredDefault}" is not accessible. Run \`caipe agents list\` or \`caipe config unset agent.default\`. Falling back to first agent.\n`,
    );
  }

  // agents is non-empty (guarded above), so agents[0] is always defined.
  const pick = agents.find((a) => a.available) ?? agents[0];
  if (!pick) {
    throw new Error("No agents returned for your account. Run `caipe agents list`.");
  }
  return pick;
}

/**
 * Resolve which dynamic agent to use for chat.
 *
 * - Explicit id/name → must exist in accessible-agents
 * - `default` / omitted → agent.default / CAIPE_DEFAULT_AGENT, else first available
 */
export async function resolveSessionAgent(
  serverUrl: string,
  getToken: () => Promise<string>,
  requestedName?: string,
): Promise<Agent> {
  const agents = await fetchAgents(serverUrl, getToken);
  return pickSessionAgent(agents, requestedName, getConfiguredDefaultAgent());
}

/**
 * Check availability flag from the agent object.
 */
export function checkAvailability(agent: Agent): boolean {
  return agent.available;
}

/**
 * Validate that the agent supports agui.
 * If the agent has no `protocols` field, assumes agui.
 */
export function validateProtocol(agent: Agent): ValidationResult {
  const supported = agent.protocols?.length > 0 ? (agent.protocols as string[]) : ["agui"];
  const valid = supported.includes("agui");
  return { valid, supported };
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function readCache(serverUrl: string, credentialFingerprint: string): CachedAgents | null {
  const path = agentsCachePath();
  if (!existsSync(path)) return null;
  try {
    const cached = JSON.parse(readFileSync(path, "utf8")) as Partial<CachedAgents>;
    if (
      cached.serverUrl !== serverUrl ||
      cached.credentialFingerprint !== credentialFingerprint ||
      typeof cached.cachedAt !== "string" ||
      !Array.isArray(cached.agents)
    ) {
      return null;
    }
    return cached as CachedAgents;
  } catch {
    return null;
  }
}

function writeCache(serverUrl: string, credentialFingerprint: string, agents: Agent[]): void {
  const dir = globalConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const cached: CachedAgents = {
    agents,
    cachedAt: new Date().toISOString(),
    serverUrl,
    credentialFingerprint,
  };
  writeFileSync(agentsCachePath(), `${JSON.stringify(cached, null, 2)}\n`, "utf8");
}
