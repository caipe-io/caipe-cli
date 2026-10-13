/**
 * Headless credential resolver (T041).
 *
 * Priority order:
 *   1. --token <jwt> / CAIPE_TOKEN  (JWT pass-through — also accepts OIDC JWTs)
 *   2. CAIPE_API_KEY (static API key)
 *   3. CAIPE_CLIENT_ID + CAIPE_CLIENT_SECRET (renewable Client Credentials)
 *   4. settings.json auth.apiKey (interactive account configuration)
 */

import { AuthRequired, getValidToken } from "../auth/tokens.js";
import { getAuthUrl, readSettings } from "../platform/config.js";
import { discoverAgentConfig, resolveOAuthEndpoints } from "../platform/discovery.js";

export type CredentialType = "jwt" | "apikey" | "client_credentials";

export interface HeadlessCredentials {
  type: CredentialType;
  /** The Bearer token to use in Authorization: Bearer <token> */
  accessToken: string;
  expiresAt?: number;
}

/** Configured credentials fail closed; they never select a different signed-in user. */
export class CredentialError extends AuthRequired {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

function nonEmptyCredential(value: string, source: string): string {
  if (!value.trim()) throw new CredentialError(`${source} is configured but empty.`);
  return value.trim();
}

function credentialSource(tokenFlag: string | undefined, authUrl: string): string {
  if (tokenFlag !== undefined) return "token-flag";
  if (process.env.CAIPE_TOKEN !== undefined) return "token-env";
  if (process.env.CAIPE_API_KEY !== undefined) return "api-key-env";
  if (process.env.CAIPE_CLIENT_ID !== undefined || process.env.CAIPE_CLIENT_SECRET !== undefined) {
    return JSON.stringify([
      "client-credentials",
      process.env.CAIPE_CLIENT_ID,
      authUrl,
      process.env.CAIPE_TOKEN_URL,
    ]);
  }
  return readSettings().auth?.apiKey !== undefined ? "stored-api-key" : "oauth";
}

/** Shared credential lifecycle for unattended ACP clients and headless commands. */
export function createTokenProvider(
  authUrl: string,
  oauthToken: () => Promise<string> = () => getValidToken(authUrl),
  tokenFlag?: string,
  initialCredentials?: HeadlessCredentials,
): () => Promise<string> {
  let cached: HeadlessCredentials | null | undefined = initialCredentials;
  let configured = initialCredentials !== undefined;
  let admittedSource = initialCredentials ? credentialSource(tokenFlag, authUrl) : undefined;
  let pending: Promise<HeadlessCredentials | null> | undefined;
  return async () => {
    if (
      cached === undefined ||
      (cached?.expiresAt !== undefined && Date.now() >= cached.expiresAt - 60_000)
    ) {
      const source = credentialSource(tokenFlag, authUrl);
      if (admittedSource !== undefined && admittedSource !== source) {
        throw new CredentialError(
          "Admitted credential source changed; reconnect with the intended account.",
        );
      }
      pending ??= resolveHeadlessCredentials(tokenFlag, authUrl);
      try {
        const resolved = await pending;
        if (configured && !resolved)
          throw new CredentialError("Configured credentials are no longer available.");
        if (cached && resolved && cached.type !== resolved.type)
          throw new CredentialError(
            "Admitted credential type changed; reconnect with the intended account.",
          );
        cached = resolved;
        configured ||= resolved !== null;
        if (resolved) admittedSource ??= source;
      } finally {
        pending = undefined;
      }
    }
    return cached ? cached.accessToken : oauthToken();
  };
}

/**
 * Resolve headless credentials from environment / flags.
 * Returns null if no credential is available.
 *
 * @param tokenFlag  Value of --token flag (highest priority)
 * @param authUrl    caipe-ui/OAuth URL — used only for client_credentials flow
 */
export async function resolveHeadlessCredentials(
  tokenFlag?: string,
  authUrl?: string,
): Promise<HeadlessCredentials | null> {
  // 1. --token flag or CAIPE_TOKEN env
  const jwt = tokenFlag ?? process.env.CAIPE_TOKEN;
  if (jwt !== undefined) {
    return { type: "jwt", accessToken: nonEmptyCredential(jwt, "CAIPE_TOKEN / --token") };
  }

  // Explicit worker credentials must win over another account's stored settings.
  const apiKey = process.env.CAIPE_API_KEY;
  if (apiKey !== undefined) {
    return {
      type: "apikey",
      accessToken: nonEmptyCredential(apiKey, "CAIPE_API_KEY / auth.apiKey"),
    };
  }

  // 3. Client Credentials (CAIPE_CLIENT_ID + CAIPE_CLIENT_SECRET)
  const clientId = process.env.CAIPE_CLIENT_ID;
  const clientSecret = process.env.CAIPE_CLIENT_SECRET;
  if (clientId !== undefined || clientSecret !== undefined) {
    if (clientId === undefined || clientSecret === undefined) {
      throw new CredentialError("Configure both CAIPE_CLIENT_ID and CAIPE_CLIENT_SECRET.");
    }
    const resolvedUrl = authUrl ?? getAuthUrl();
    return clientCredentialsExchange(
      nonEmptyCredential(clientId, "CAIPE_CLIENT_ID"),
      nonEmptyCredential(clientSecret, "CAIPE_CLIENT_SECRET"),
      resolvedUrl,
    );
  }

  const storedApiKey = readSettings().auth?.apiKey;
  if (storedApiKey !== undefined) {
    return {
      type: "apikey",
      accessToken: nonEmptyCredential(storedApiKey, "auth.apiKey"),
    };
  }

  return null;
}

async function clientCredentialsExchange(
  clientId: string,
  clientSecret: string,
  authUrl: string,
): Promise<HeadlessCredentials> {
  try {
    // Service-account provisioning returns the token URL. Otherwise reuse the
    // normal OIDC discovery path; Keycloak does not expose /oauth/token.
    const configuredEndpoint = process.env.CAIPE_TOKEN_URL;
    const tokenEndpoint =
      configuredEndpoint !== undefined
        ? nonEmptyCredential(configuredEndpoint, "CAIPE_TOKEN_URL")
        : resolveOAuthEndpoints(authUrl, await discoverAgentConfig(authUrl), clientId)
            .tokenEndpoint;
    const endpoint = new URL(tokenEndpoint);
    if (
      !["https:", "http:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash
    ) {
      throw new CredentialError(
        "CAIPE token endpoint must be an HTTP(S) URL without embedded credentials.",
      );
    }
    const res = await fetch(endpoint.href, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) throw new CredentialError(`Client credentials rejected (HTTP ${res.status}).`);

    const body = (await res.json()) as Record<string, unknown>;
    const accessToken = body.access_token;
    if (typeof accessToken !== "string" || !accessToken.trim()) {
      throw new CredentialError("Client credentials exchange returned no access token.");
    }
    const expiresIn =
      typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 300;
    return { type: "client_credentials", accessToken, expiresAt: Date.now() + expiresIn * 1000 };
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    throw new CredentialError(
      "Client credentials exchange failed; verify the configured OAuth server.",
    );
  }
}
