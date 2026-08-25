/** Run the CAIPE ACP agent over newline-delimited JSON-RPC on stdio. */

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { runLogin } from "../auth/commands.js";
import { CaipeAcpAgent } from "./server.js";

export interface AcpCommandOptions {
  agent?: string;
  login?: boolean;
  noContext?: boolean;
}

export interface AcpGlobalOptions {
  agent?: string;
  url?: string;
}

export async function runAcp(
  options: AcpCommandOptions,
  globalOptions: AcpGlobalOptions,
  version: string,
): Promise<void> {
  if (options.login) {
    await runLogin({ isolated: true }, globalOptions);
    return;
  }

  const bridge = new CaipeAcpAgent({
    agentName: options.agent ?? globalOptions.agent,
    noContext: options.noContext ?? false,
    urlOverride: globalOptions.url,
    version,
  });
  const output = Writable.toWeb(process.stdout);
  const input = Readable.toWeb(process.stdin);
  const connection = bridge.createApp().connect(acp.ndJsonStream(output, input));
  await connection.closed;
}
