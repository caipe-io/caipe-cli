/**
 * caipe chat command runner.
 *
 * Handles both interactive (Ink REPL) and headless (no TTY) modes.
 * All streaming uses AG-UI via /api/v1/chat/stream/start on the caipe-ui BFF.
 */

import { render } from "ink";
import React from "react";

import { resolveSessionAgent } from "../agents/registry.js";
import { getValidToken } from "../auth/tokens.js";
import {
  ServerNotConfigured,
  authEndpoints,
  getAuthUrl,
  getServerUrl,
} from "../platform/config.js";
import { printLogo } from "../platform/display.js";
import { getTerminalCapabilities } from "../platform/markdown.js";
import { runSetupWizard } from "../platform/setup.js";
import {
  enterAlternateScreen,
  installAlternateScreenCleanup,
  leaveAlternateScreen,
} from "../platform/terminal/screen.js";
import { Repl } from "./Repl.js";
import { buildSystemContext } from "./context.js";
import { createSession, saveSession } from "./history.js";
import type { ChatSession } from "./history.js";
import { createAdapter } from "./stream.js";

interface ChatOpts {
  agent?: string;
  noContext?: boolean;
  resume?: string;
  headless?: boolean;
  token?: string;
  prompt?: string;
  promptFile?: string;
  output?: string;
  interactiveStdin?: boolean;
}

interface GlobalOpts {
  url?: string;
  agent?: string;
}

export async function runChat(opts: ChatOpts, globalOpts: GlobalOpts): Promise<void> {
  const isHeadless = !process.stdout.isTTY || opts.headless === true;

  // In headless mode, delegate entirely to the headless runner
  if (isHeadless) {
    const { runHeadless } = await import("../headless/runner.js");
    await runHeadless({
      token: opts.token,
      prompt: opts.prompt,
      promptFile: opts.promptFile,
      output: (opts.output as "text" | "json" | "ndjson") ?? "text",
      interactiveStdin: opts.interactiveStdin ?? false,
      agentName: opts.agent ?? globalOpts.agent ?? "default",
      noContext: opts.noContext ?? false,
    });
    return;
  }

  // ── Interactive mode ────────────────────────────────────────────────────

  // Resolve auth (caipe-ui/OAuth) URL
  let authUrl: string;
  try {
    authUrl = getAuthUrl(globalOpts.url);
  } catch (err) {
    if (err instanceof ServerNotConfigured) {
      authUrl = await runSetupWizard();
    } else {
      throw err;
    }
  }

  // Ensure user is authenticated before opening the REPL
  const tokens = await import("../auth/tokens.js");
  const keychain = await import("../auth/keychain.js");
  const existing = await keychain.loadTokens();
  if (!existing || tokens.isExpired(existing)) {
    const { loginBrowser } = await import("../auth/oauth.js");
    process.stdout.write("You need to log in first.\n");
    await loginBrowser(authUrl, "caipe-cli");
  }

  const termCaps = getTerminalCapabilities();
  if (termCaps.alternateScreen) {
    installAlternateScreenCleanup();
    enterAlternateScreen();
  }

  printLogo();

  // Stream endpoint: caipe-ui BFF (may differ from authUrl when KC is separate)
  let serverUrl: string;
  try {
    serverUrl = getServerUrl(globalOpts.url);
  } catch {
    serverUrl = authUrl; // fallback: single-URL setup
  }

  const getToken = () => getValidToken(authUrl);

  let resolvedAgent;
  try {
    resolvedAgent = await resolveSessionAgent(
      serverUrl,
      getToken,
      opts.agent ?? globalOpts.agent,
    );
  } catch (err) {
    process.stderr.write(`[ERROR] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  }
  const agentName = resolvedAgent.name;

  // Gather context (inject agents + skills for richer system prompt)
  const cwd = process.cwd();
  const systemContext = await buildSystemContext(cwd, opts.noContext ?? false, {
    serverUrl,
    getToken,
  });

  // Create or resume session
  let session: ChatSession;
  if (opts.resume) {
    const { loadSession } = await import("./history.js");
    const existing = loadSession(opts.resume);
    if (!existing) {
      process.stderr.write(
        `[WARN] Session ${opts.resume} not found; starting a new session.\n`,
      );
      session = createSession({ agentName, workingDir: cwd });
      session.memoryContext = systemContext;
    } else {
      session = existing;
      session.workingDir = cwd;
    }
  } else {
    session = createSession({ agentName, workingDir: cwd });
    session.memoryContext = systemContext;
  }

  const ep = authEndpoints(serverUrl);
  const adapter = createAdapter(resolvedAgent, ep.streamStart, getToken, {
    conversationIds:
      session.conversationId != null
        ? { [session.sessionId]: session.conversationId }
        : undefined,
  });

  // Mount REPL
  return new Promise<void>((resolve) => {
    const { unmount } = render(
      React.createElement(Repl, {
        session,
        adapter,
        initialAgent: resolvedAgent,
        systemContext,
        serverUrl: serverUrl,
        onExit: (finalSession: ChatSession) => {
          saveSession(finalSession);
          unmount();
          leaveAlternateScreen();
          resolve();
        },
      }),
    );
  });
}

async function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        resolve(buf.slice(0, nl));
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

void readLine; // keep for potential future use
