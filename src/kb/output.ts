/**
 * KB commands always emit JSON (AWS CLI style).
 */

import { KbApiError } from "./client.js";

export function writeKbJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function writeKbError(err: unknown): never {
  if (err instanceof KbApiError) {
    process.stderr.write(
      `${JSON.stringify({ error: err.message, status: err.status, body: err.body ?? null }, null, 2)}\n`,
    );
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
  process.exit(1);
}
