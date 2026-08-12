/**
 * `caipe sessions list` — show saved REPL sessions (for `--resume`).
 */

import { listSessions } from "./history.js";

export async function runSessionsList(opts: { json?: boolean }): Promise<void> {
  const sessions = listSessions();
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
    return;
  }

  if (sessions.length === 0) {
    process.stdout.write("No saved sessions. Exit a chat REPL to persist one.\n");
    return;
  }

  process.stdout.write(
    "Saved sessions (resume with `caipe chat --resume <sessionId>` or `/resume` in the REPL):\n\n",
  );
  for (const s of sessions) {
    const started = s.startedAt.slice(0, 19).replace("T", " ");
    process.stdout.write(`  ${s.sessionId}  ${s.agentName}  ${s.messageCount} msg  ${started}\n`);
  }
  process.stdout.write("\n");
}
