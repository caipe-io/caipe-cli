/**
 * Resolve Bearer tokens for KB API calls (scriptable + interactive).
 */

import { getValidToken } from "../auth/tokens.js";
import { resolveHeadlessCredentials } from "../headless/auth.js";

export interface KbAuthOptions {
  token?: string;
  authUrl?: string;
}

export async function resolveKbAccessToken(options: KbAuthOptions): Promise<string> {
  const headless = await resolveHeadlessCredentials(options.token, options.authUrl);
  if (headless) {
    return headless.accessToken;
  }
  if (!options.authUrl) {
    throw new Error("authUrl is required when resolving interactive credentials");
  }
  return getValidToken(options.authUrl);
}
