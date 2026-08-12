/**
 * Non-interactive Knowledge Base commands (JSON output).
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { getAuthUrl } from "../platform/config.js";
import { chunkContentApiPath, kbRequest } from "./client.js";
import { writeKbError, writeKbJson } from "./output.js";

export interface KbCommandContext {
  authUrl?: string;
  kbUrl?: string;
  token?: string;
  tenantId?: string;
}

function ctx(opts: KbCommandContext): KbCommandContext {
  return {
    authUrl: getAuthUrl(opts.authUrl),
    kbUrl: opts.kbUrl,
    token: opts.token,
    tenantId: opts.tenantId,
  };
}

export async function runKbUserInfo(opts: KbCommandContext): Promise<void> {
  try {
    const data = await kbRequest("/v1/user/info", ctx(opts));
    writeKbJson(data);
  } catch (e) {
    writeKbError(e);
  }
}

export async function runKbDatasourcesList(opts: KbCommandContext): Promise<void> {
  try {
    const data = await kbRequest("/v1/datasources", ctx(opts));
    writeKbJson(data);
  } catch (e) {
    writeKbError(e);
  }
}

export async function runKbDocumentsList(
  datasourceId: string,
  opts: KbCommandContext & { offset?: number; limit?: number },
): Promise<void> {
  try {
    const data = await kbRequest(`/v1/datasource/${encodeURIComponent(datasourceId)}/documents`, {
      ...ctx(opts),
      searchParams: { offset: opts.offset ?? 0, limit: opts.limit ?? 100 },
    });
    writeKbJson(data);
  } catch (e) {
    writeKbError(e);
  }
}

export async function runKbChunkGet(chunkId: string, opts: KbCommandContext): Promise<void> {
  try {
    const data = await kbRequest(chunkContentApiPath(chunkId), ctx(opts));
    writeKbJson(data);
  } catch (e) {
    writeKbError(e);
  }
}

export async function runKbQuery(
  query: string,
  opts: KbCommandContext & { limit?: number },
): Promise<void> {
  try {
    const data = await kbRequest("/v1/query", {
      ...ctx(opts),
      method: "POST",
      body: {
        query,
        limit: opts.limit ?? 10,
      },
    });
    writeKbJson(data);
  } catch (e) {
    writeKbError(e);
  }
}

export async function runKbJobGet(jobId: string, opts: KbCommandContext): Promise<void> {
  try {
    const data = await kbRequest(`/v1/job/${encodeURIComponent(jobId)}`, ctx(opts));
    writeKbJson(data);
  } catch (e) {
    writeKbError(e);
  }
}

export async function runKbJobsByDatasource(
  datasourceId: string,
  opts: KbCommandContext,
): Promise<void> {
  try {
    const data = await kbRequest(
      `/v1/jobs/datasource/${encodeURIComponent(datasourceId)}`,
      ctx(opts),
    );
    writeKbJson(data);
  } catch (e) {
    writeKbError(e);
  }
}

export async function runKbIngestUrl(
  url: string,
  opts: KbCommandContext & { description?: string; ownerTeamSlug?: string },
): Promise<void> {
  try {
    const data = await kbRequest("/v1/ingest/webloader/url", {
      ...ctx(opts),
      method: "POST",
      body: {
        url,
        description: opts.description ?? "",
        owner_team_slug: opts.ownerTeamSlug,
      },
    });
    writeKbJson(data);
  } catch (e) {
    writeKbError(e);
  }
}

export async function runKbIngestFile(
  paths: string[],
  opts: KbCommandContext & {
    description?: string;
    ownerTeamSlug?: string;
    chunkSize?: number;
    chunkOverlap?: number;
  },
): Promise<void> {
  try {
    const form = new FormData();
    for (const p of paths) {
      const buf = readFileSync(p);
      const name = basename(p);
      form.append("file", new Blob([buf]), name);
    }
    if (opts.description) form.append("description", opts.description);
    if (opts.ownerTeamSlug) form.append("owner_team_slug", opts.ownerTeamSlug);
    if (opts.chunkSize !== undefined) form.append("chunk_size", String(opts.chunkSize));
    if (opts.chunkOverlap !== undefined) form.append("chunk_overlap", String(opts.chunkOverlap));

    const data = await kbRequest("/v1/ingest/local-file", {
      ...ctx(opts),
      method: "POST",
      rawBody: form,
    });
    writeKbJson(data);
  } catch (e) {
    writeKbError(e);
  }
}

export type KbCommandContextInput = KbCommandContext;
