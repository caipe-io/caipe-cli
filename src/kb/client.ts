/**
 * HTTP client for the CAIPE Knowledge Base RAG REST API.
 */

import { getAuthUrl, getKbUrl } from "../platform/config.js";
import { type KbAuthOptions, resolveKbAccessToken } from "./auth.js";

export interface KbRequestOptions extends KbAuthOptions {
  kbUrl?: string;
  tenantId?: string;
  method?: string;
  body?: unknown;
  /** Raw body (e.g. multipart FormData) — skips JSON Content-Type */
  rawBody?: NonNullable<RequestInit["body"]>;
  searchParams?: Record<string, string | number | undefined>;
}

export class KbApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "KbApiError";
  }
}

function joinKbPath(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

/** FastAPI `{chunk_id:path}` — preserve slashes inside chunk ids */
export function chunkContentApiPath(chunkId: string): string {
  const id = chunkId.replace(/^\/+|\/+$/g, "");
  return `/v1/chunk/${id}/content`;
}

export async function kbRequest<T = unknown>(
  path: string,
  options: KbRequestOptions = {},
): Promise<T> {
  const base = getKbUrl(options.kbUrl);
  const authUrl = getAuthUrl(options.authUrl);
  const token = await resolveKbAccessToken({ ...options, authUrl });

  const url = new URL(joinKbPath(base, path));
  if (options.searchParams) {
    for (const [key, value] of Object.entries(options.searchParams)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (options.tenantId && options.tenantId.trim() !== "") {
    headers["X-Tenant-Id"] = options.tenantId.trim();
  }

  let body: NonNullable<RequestInit["body"]> | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const res = await fetch(url.toString(), {
    method: options.method ?? (body !== undefined ? "POST" : "GET"),
    headers,
    body,
  });

  const text = await res.text();
  let parsed: unknown = text;
  if (text !== "") {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  } else {
    parsed = null;
  }

  if (!res.ok) {
    const detail =
      typeof parsed === "object" && parsed !== null && "detail" in parsed
        ? String((parsed as { detail: unknown }).detail)
        : typeof parsed === "string"
          ? parsed
          : res.statusText;
    throw new KbApiError(detail || `HTTP ${res.status}`, res.status, parsed);
  }

  return parsed as T;
}
