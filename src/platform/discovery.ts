/**
 * /.well-known/agent.json endpoint discovery (FR-023).
 *
 * Fetches caipe-ui's agent discovery document and caches it for 24 hours in
 * ~/.config/caipe/agent-config.json.  All OAuth endpoint URLs and the
 * OAuth client_id are read from the discovery document when present, falling
 * back to conventional /oauth/* paths when absent or when discovery fails.
 *
 * This makes the CLI IdP-agnostic: caipe-ui can proxy OAuth to Okta today and
 * Keycloak tomorrow without any CLI change.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentOAuthConfig {
  /** OIDC issuer (realm URL), when known from discovery */
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  device_authorization_endpoint?: string;
  client_id?: string;
  scopes?: string[];
}

export interface AgentA2AConfig {
  /** Full URL of the A2A task endpoint (e.g. http://localhost:8000/tasks/send) */
  endpoint?: string;
}

export interface AgentConfig {
  oauth?: AgentOAuthConfig;
  a2a?: AgentA2AConfig;
  /** ISO 8601 — when this cache entry expires */
  _cachedAt?: string;
}

// ---------------------------------------------------------------------------
// Cache path
// ---------------------------------------------------------------------------

function agentConfigPath(): string {
  return join(globalConfigDir(), "agent-config.json");
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Internal read/write
// ---------------------------------------------------------------------------

function readCache(serverUrl: string): (AgentConfig & { _cachedAt: string }) | null {
  const p = agentConfigPath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as AgentConfig & { _cachedAt?: string; _sourceUrl?: string };
    if (!parsed._cachedAt || parsed._sourceUrl !== serverUrl) return null;
    if (Date.now() - new Date(parsed._cachedAt).getTime() > CACHE_TTL_MS) return null;
    return parsed as AgentConfig & { _cachedAt: string };
  } catch {
    return null;
  }
}

function writeCache(serverUrl: string, config: AgentConfig): void {
  const dir = globalConfigDir();
  mkdirSync(dir, { recursive: true });
  const entry = { ...config, _sourceUrl: serverUrl, _cachedAt: new Date().toISOString() };
  writeFileSync(agentConfigPath(), JSON.stringify(entry, null, 2));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch (or return cached) /.well-known/agent.json for the given server URL.
 *
 * Falls back to OIDC standard discovery (/.well-known/openid-configuration)
 * when agent.json is absent — covers direct Keycloak URLs and any OIDC IdP.
 *
 * Never throws — on any failure returns an empty config so callers fall back
 * to conventional /oauth/* paths.
 */
export async function discoverAgentConfig(serverUrl: string): Promise<AgentConfig> {
  const cached = readCache(serverUrl);
  if (cached) return cached;

  // Try caipe-specific agent.json first
  try {
    const url = `${serverUrl}/.well-known/agent.json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const json = (await res.json()) as AgentConfig;
      writeCache(serverUrl, json);
      return json;
    }
  } catch {
    // fall through to OIDC discovery
  }

  // Fall back to standard OIDC discovery (works for Keycloak, Okta, etc.)
  try {
    const url = `${serverUrl}/.well-known/openid-configuration`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const oidc = (await res.json()) as Record<string, unknown>;
      const config: AgentConfig = {
        oauth: {
          issuer: typeof oidc.issuer === "string" ? oidc.issuer.replace(/\/+$/, "") : undefined,
          authorization_endpoint: oidc.authorization_endpoint as string | undefined,
          token_endpoint: oidc.token_endpoint as string | undefined,
          device_authorization_endpoint: oidc.device_authorization_endpoint as string | undefined,
        },
      };
      writeCache(serverUrl, config);
      return config;
    }
  } catch {
    // fall through to conventional paths
  }

  return {};
}

/**
 * Invalidate the cached agent config (e.g. after server URL changes).
 */
export function clearAgentConfigCache(): void {
  const p = agentConfigPath();
  if (existsSync(p)) {
    try {
      writeFileSync(p, JSON.stringify({}));
    } catch {
      // best-effort
    }
  }
}

const OIDC_ENDPOINT_SUFFIXES = [
  "/protocol/openid-connect/auth/device",
  "/protocol/openid-connect/auth",
  "/protocol/openid-connect/token",
  "/oauth/device/code",
  "/oauth/authorize",
  "/oauth/token",
] as const;

/**
 * Derive the OIDC issuer (Keycloak realm base URL) from discovery OAuth fields.
 * Used to auto-set `auth.url` after `server.url` is configured.
 */
export function oauthIssuerFromConfig(config: AgentConfig): string | undefined {
  const oauth = config.oauth;
  if (!oauth) return undefined;

  if (oauth.issuer?.trim()) {
    return oauth.issuer.trim().replace(/\/+$/, "");
  }

  const candidates = [
    oauth.token_endpoint,
    oauth.authorization_endpoint,
    oauth.device_authorization_endpoint,
  ].filter((u): u is string => typeof u === "string" && u.length > 0);

  for (const url of candidates) {
    for (const suffix of OIDC_ENDPOINT_SUFFIXES) {
      if (url.endsWith(suffix)) {
        return url.slice(0, -suffix.length).replace(/\/+$/, "");
      }
    }
  }

  return undefined;
}

export interface AuthIssuerDiscovery {
  issuer: string;
  /** Short explanation for CLI output (no secrets) */
  detail: string;
}

const DEFAULT_OAUTH_REALM = "caipe";

/**
 * Guess Keycloak realm issuer URLs when the BFF does not publish agent.json.
 *
 * Grid-style hosts: `grid.example.com` → `idp.grid.example.com/realms/<realm>`.
 * Override realm with `CAIPE_AUTH_REALM` (default `caipe`).
 */
export function heuristicAuthIssuerCandidates(serverUrl: string): string[] {
  const trimmed = serverUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return [];
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return [];
  }

  const realm = process.env.CAIPE_AUTH_REALM?.trim() || DEFAULT_OAUTH_REALM;
  const host = parsed.hostname;
  const candidates: string[] = [];

  if (host.startsWith("grid.")) {
    candidates.push(`${parsed.protocol}//idp.${host}/realms/${realm}`);
  }

  // Keycloak served under /realms/ on the same host as the UI
  candidates.push(`${parsed.protocol}//${host}/realms/${realm}`);

  return [...new Set(candidates)];
}

async function issuerFromDiscoveryBase(baseUrl: string): Promise<string | undefined> {
  clearAgentConfigCache();
  const config = await discoverAgentConfig(baseUrl);
  return oauthIssuerFromConfig(config);
}

/**
 * Fetch `/.well-known/agent.json` (or OIDC metadata) for `serverUrl`, then try
 * heuristic IdP URLs, and return the issuer for `auth.url` when found.
 */
export async function discoverAuthIssuer(
  serverUrl: string,
): Promise<AuthIssuerDiscovery | undefined> {
  const base = serverUrl.trim().replace(/\/+$/, "");

  const direct = await issuerFromDiscoveryBase(base);
  if (direct) {
    return {
      issuer: direct,
      detail: `${base} (well-known discovery)`,
    };
  }

  for (const candidate of heuristicAuthIssuerCandidates(base)) {
    const issuer = await issuerFromDiscoveryBase(candidate);
    if (issuer) {
      return {
        issuer,
        detail: `${candidate} (inferred from ${base})`,
      };
    }
  }

  return undefined;
}

/**
 * Resolve OAuth agent config: BFF agent.json, auth URL OIDC, then heuristic IdP hosts.
 */
export async function discoverOAuthAgentConfig(
  serverUrl: string,
  authUrl: string,
): Promise<AgentConfig> {
  let config: AgentConfig = {};

  try {
    const bffConfig = await discoverAgentConfig(serverUrl);
    if (bffConfig.oauth?.authorization_endpoint) {
      return bffConfig;
    }
    config = bffConfig;
  } catch {
    // server.url not configured
  }

  if (!config.oauth?.authorization_endpoint) {
    clearAgentConfigCache();
    const authConfig = await discoverAgentConfig(authUrl);
    config = {
      oauth: { ...config.oauth, ...authConfig.oauth },
      a2a: authConfig.a2a ?? config.a2a,
    };
  }

  if (!config.oauth?.authorization_endpoint) {
    for (const candidate of heuristicAuthIssuerCandidates(serverUrl)) {
      clearAgentConfigCache();
      const guessed = await discoverAgentConfig(candidate);
      if (guessed.oauth?.authorization_endpoint) {
        return guessed;
      }
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// Resolved endpoints (discovery → fallback)
// ---------------------------------------------------------------------------

export interface ResolvedOAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint: string;
  clientId: string;
  scopes: string[];
}

export function resolveOAuthEndpoints(
  serverUrl: string,
  config: AgentConfig,
  defaultClientId: string,
): ResolvedOAuthEndpoints {
  const oauth = config.oauth ?? {};
  return {
    authorizationEndpoint: oauth.authorization_endpoint ?? `${serverUrl}/oauth/authorize`,
    tokenEndpoint: oauth.token_endpoint ?? `${serverUrl}/oauth/token`,
    deviceAuthorizationEndpoint:
      oauth.device_authorization_endpoint ?? `${serverUrl}/oauth/device/code`,
    clientId: oauth.client_id ?? defaultClientId,
    scopes: oauth.scopes ?? ["openid", "profile", "email"],
  };
}
