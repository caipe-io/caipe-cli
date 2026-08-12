/**
 * Line-delimited stdin reader (Apache-2.0).
 *
 * Does not use Node's `node:readline` module (avoids confusion with GNU Readline, which is GPL).
 * Suitable for headless interactive stdin where only newline splitting is needed.
 */

/**
 * Async iterator over newline-delimited lines from stdin (trailing `\r` stripped).
 */
export async function* readStdinLines(
  input: NodeJS.ReadableStream = process.stdin,
): AsyncGenerator<string, void, undefined> {
  const pending: string[] = [];
  let notify: (() => void) | null = null;
  let ended = false;
  let buffer = "";

  const flushLines = (): void => {
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      pending.push(raw.replace(/\r$/, ""));
      nl = buffer.indexOf("\n");
    }
    notify?.();
  };

  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    flushLines();
  });
  input.on("end", () => {
    if (buffer.length > 0) {
      pending.push(buffer.replace(/\r$/, ""));
      buffer = "";
    }
    ended = true;
    notify?.();
  });
  input.resume();

  while (true) {
    if (pending.length === 0) {
      if (ended) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      notify = null;
      if (pending.length === 0 && ended) return;
    }
    const line = pending.shift();
    if (line !== undefined) yield line;
  }
}
