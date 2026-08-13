#!/usr/bin/env node
import { Command } from "commander";
import pkg from "../package.json";

// Suppress color when --no-color or NO_COLOR is set.
// This is done early so all downstream renderers respect it.
function applyNoColor(args: string[]): void {
  if (args.includes("--no-color") || process.env.NO_COLOR) {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "0";
  }
}
applyNoColor(process.argv);

const program = new Command();

program
  .name("caipe")
  .description("Custom Agents, workflows and more... caipe.io")
  .version(pkg.version, "-v, --version", "Print version and exit")
  .option(
    "--agent <name>",
    "Dynamic agent id from `caipe agents list` (default: agent.default setting, else first accessible)",
    "default",
  )
  .option("--url <url>", "Override server.url from settings.json for this invocation only")
  .option("--no-color", "Disable ANSI color output")
  .option("--json", "Machine-readable JSON output (non-interactive commands only)");

// ---------------------------------------------------------------------------
// caipe chat
// ---------------------------------------------------------------------------
const chatCmd = program
  .command("chat")
  .description("Start a chat session with an agent")
  .option("--agent <name>", "Pin session to this CAIPE server agent")
  .option("--no-context", "Skip git/repo context gathering")
  .option("--resume <sessionId>", "Resume a previous session by ID")
  .option("--headless", "Force headless mode even when TTY is present")
  .option("--token <jwt>", "JWT to use directly (highest auth priority)")
  .option("--prompt <text>", "Inline prompt text (headless only)")
  .option("--prompt-file <path>", "Read prompt from file (headless only)")
  .option("--output <format>", "Headless response format: text | json | ndjson", "text")
  .option(
    "--interactive-stdin",
    "Multi-turn headless mode; reads newline-delimited turns from stdin",
  )
  .action(async (opts: Record<string, unknown>) => {
    const { runChat } = await import("./chat/runner.js");
    await runChat(opts, program.opts());
  });

void chatCmd;

// ---------------------------------------------------------------------------
// caipe auth
// ---------------------------------------------------------------------------
const authCmd = program.command("auth").description("Manage authentication");

authCmd
  .command("login")
  .description("Authenticate with the CAIPE server")
  .option("--manual", "Print auth URL only; wait for user to paste authorization code back")
  .option(
    "--device",
    "Device Authorization Grant (RFC 8628): display short user code + URL, poll until approved",
  )
  .option("--force", "Re-authenticate even if a valid session already exists")
  .option("--setup-wizard", "Re-run the server URL setup wizard before logging in")
  .option(
    "--isolated",
    "OAuth in an isolated Chromium profile (default; avoids corrupting Web UI sessions)",
  )
  .option(
    "--system-browser",
    "OAuth in your default browser profile (may affect an open Web UI tab)",
  )
  .option(
    "--callback-port <port>",
    "OAuth loopback port; the IdP must register the matching redirect URI",
  )
  .action(async (opts: Record<string, unknown>) => {
    const { runLogin } = await import("./auth/commands.js");
    await runLogin(
      {
        manual: opts.manual === true,
        device: opts.device === true,
        force: opts.force === true,
        setupWizard: opts.setupWizard === true,
        isolated: opts.isolated === true,
        systemBrowser: opts.systemBrowser === true,
        callbackPort: typeof opts.callbackPort === "string" ? Number(opts.callbackPort) : undefined,
      },
      program.opts(),
    );
  });

authCmd
  .command("logout")
  .description("Remove stored credentials")
  .action(async () => {
    const { runLogout } = await import("./auth/commands.js");
    await runLogout();
  });

authCmd
  .command("status")
  .description("Print current auth state")
  .option("--json", "Output JSON")
  .action(async (opts: Record<string, unknown>) => {
    const { runStatus } = await import("./auth/commands.js");
    await runStatus(opts, program.opts());
  });

// ---------------------------------------------------------------------------
// caipe config
// ---------------------------------------------------------------------------
const configCmd = program.command("config").description("Manage CLI configuration");

configCmd
  .command("set <key> <value>")
  .description("Set a configuration key")
  .action(async (key: string, value: string) => {
    const { runConfigSet } = await import("./platform/configcmd.js");
    await runConfigSet(key, value);
  });

configCmd
  .command("get <key>")
  .description("Print the current value of a configuration key")
  .option("--json", "Output JSON")
  .action(async (key: string, opts: Record<string, unknown>) => {
    const { runConfigGet } = await import("./platform/configcmd.js");
    await runConfigGet(key, opts);
  });

configCmd
  .command("unset <key>")
  .description("Remove a configuration key")
  .action(async (key: string) => {
    const { runConfigUnset } = await import("./platform/configcmd.js");
    await runConfigUnset(key);
  });

configCmd
  .command("discover")
  .description("Set auth.url from server.url (well-known + IdP heuristics)")
  .action(async () => {
    const { runConfigDiscover } = await import("./platform/configcmd.js");
    await runConfigDiscover();
  });

// ---------------------------------------------------------------------------
// caipe sessions
// ---------------------------------------------------------------------------
const sessionsCmd = program.command("sessions").description("List saved chat sessions");

sessionsCmd
  .command("list")
  .description("List sessions saved on exit (use with chat --resume)")
  .option("--json", "Output JSON array")
  .action(async (opts: Record<string, unknown>) => {
    const { runSessionsList } = await import("./chat/sessions-cmd.js");
    await runSessionsList({ json: opts.json === true });
  });

// ---------------------------------------------------------------------------
// caipe skills
// ---------------------------------------------------------------------------
const skillsCmd = program
  .command("skills")
  .description("Manage the skills catalog and installed skills");

skillsCmd
  .command("list")
  .description("List available skills from catalog")
  .option("--tag <tag>", "Filter by tag")
  .option("--installed", "Show only installed skills")
  .option("--json", "Output JSON array")
  .action(async (opts: Record<string, unknown>) => {
    const { runSkillsList } = await import("./skills/commands.js");
    await runSkillsList(opts);
  });

skillsCmd
  .command("preview <name>")
  .description("Display full SKILL.md content in terminal")
  .action(async (name: string) => {
    const { runSkillsPreview } = await import("./skills/commands.js");
    await runSkillsPreview(name);
  });

skillsCmd
  .command("install <name>")
  .description("Install a skill from the catalog")
  .option("--global", "Install to ~/.config/caipe/skills/")
  .option("--target <dir>", "Override install directory")
  .option("--force", "Overwrite if already installed")
  .action(async (name: string, opts: Record<string, unknown>) => {
    const { runSkillsInstall } = await import("./skills/commands.js");
    await runSkillsInstall(name, opts);
  });

skillsCmd
  .command("update [name]")
  .description("Check and update installed skills")
  .option("--all", "Check and update all installed skills")
  .option("--dry-run", "Report available updates without applying")
  .action(async (name: string | undefined, opts: Record<string, unknown>) => {
    const { runSkillsUpdate } = await import("./skills/commands.js");
    await runSkillsUpdate(name, opts);
  });

// ---------------------------------------------------------------------------
// caipe agents
// ---------------------------------------------------------------------------
const agentsCmd = program.command("agents").description("List and inspect CAIPE server agents");

agentsCmd
  .command("list")
  .description("List available agents")
  .option("--json", "Output JSON array")
  .action(async (opts: Record<string, unknown>) => {
    const { runAgentsList } = await import("./agents/commands.js");
    await runAgentsList(opts, program.opts());
  });

agentsCmd
  .command("info <name>")
  .description("Show full capability description for a specific agent")
  .action(async (name: string) => {
    const { runAgentsInfo } = await import("./agents/commands.js");
    await runAgentsInfo(name, program.opts());
  });

// ---------------------------------------------------------------------------
// caipe kb (Knowledge Base — JSON output for scripts)
// ---------------------------------------------------------------------------
const kbCmd = program
  .command("kb")
  .description("Knowledge Base API (non-interactive JSON; ingestion, read, RBAC)")
  .option("--kb-url <url>", "Override kb.url / CAIPE_KB_URL for this invocation")
  .option("--token <jwt>", "Bearer JWT (or use CAIPE_TOKEN / OAuth session)")
  .option("--tenant-id <id>", "X-Tenant-Id header (or CAIPE_TENANT_ID)");

function kbCtx(cmdOpts: Record<string, unknown>): import("./kb/commands.js").KbCommandContextInput {
  const globalOpts = program.opts() as { url?: string };
  const parentOpts = kbCmd.opts() as {
    kbUrl?: string;
    token?: string;
    tenantId?: string;
  };
  return {
    authUrl: globalOpts.url,
    kbUrl: (cmdOpts.kbUrl as string | undefined) ?? parentOpts.kbUrl,
    token: (cmdOpts.token as string | undefined) ?? parentOpts.token,
    tenantId:
      (cmdOpts.tenantId as string | undefined) ??
      parentOpts.tenantId ??
      process.env.CAIPE_TENANT_ID,
  };
}

const kbUserCmd = kbCmd.command("user").description("Current user and RBAC permissions");

kbUserCmd
  .command("info")
  .description("GET /v1/user/info")
  .action(async (opts: Record<string, unknown>) => {
    const { runKbUserInfo } = await import("./kb/commands.js");
    await runKbUserInfo(kbCtx(opts));
  });

const kbDsCmd = kbCmd.command("datasources").description("List knowledge sources");

kbDsCmd
  .command("list")
  .description("GET /v1/datasources")
  .action(async (opts: Record<string, unknown>) => {
    const { runKbDatasourcesList } = await import("./kb/commands.js");
    await runKbDatasourcesList(kbCtx(opts));
  });

const kbDocCmd = kbCmd.command("documents").description("Documents and chunks in a datasource");

kbDocCmd
  .command("list <datasourceId>")
  .description("GET /v1/datasource/{id}/documents")
  .option("--offset <n>", "Pagination offset", "0")
  .option("--limit <n>", "Page size (max 1000)", "100")
  .action(async (datasourceId: string, opts: Record<string, unknown>) => {
    const { runKbDocumentsList } = await import("./kb/commands.js");
    await runKbDocumentsList(datasourceId, {
      ...kbCtx(opts),
      offset: Number(opts.offset),
      limit: Number(opts.limit),
    });
  });

const kbChunkCmd = kbCmd.command("chunk").description("Fetch chunk payload");

kbChunkCmd
  .command("get <chunkId>")
  .description("GET /v1/chunk/{id}/content")
  .action(async (chunkId: string, opts: Record<string, unknown>) => {
    const { runKbChunkGet } = await import("./kb/commands.js");
    await runKbChunkGet(chunkId, kbCtx(opts));
  });

kbCmd
  .command("query")
  .description("POST /v1/query (semantic search)")
  .requiredOption("--query <text>", "Search query")
  .option("--limit <n>", "Max results", "10")
  .action(async (opts: Record<string, unknown>) => {
    const { runKbQuery } = await import("./kb/commands.js");
    await runKbQuery(String(opts.query), {
      ...kbCtx(opts),
      limit: Number(opts.limit),
    });
  });

const kbJobCmd = kbCmd.command("job").description("Ingestion job status");

kbJobCmd
  .command("get <jobId>")
  .description("GET /v1/job/{id}")
  .action(async (jobId: string, opts: Record<string, unknown>) => {
    const { runKbJobGet } = await import("./kb/commands.js");
    await runKbJobGet(jobId, kbCtx(opts));
  });

kbJobCmd
  .command("list-by-datasource <datasourceId>")
  .description("GET /v1/jobs/datasource/{id}")
  .action(async (datasourceId: string, opts: Record<string, unknown>) => {
    const { runKbJobsByDatasource } = await import("./kb/commands.js");
    await runKbJobsByDatasource(datasourceId, kbCtx(opts));
  });

const kbIngestCmd = kbCmd
  .command("ingest")
  .description("Queue ingestion (requires ingest permission)");

kbIngestCmd
  .command("url")
  .description("POST /v1/ingest/webloader/url")
  .requiredOption("--url <url>", "URL to ingest")
  .option("--description <text>", "Datasource description")
  .option("--owner-team-slug <slug>", "Owning team for RBAC")
  .action(async (opts: Record<string, unknown>) => {
    const { runKbIngestUrl } = await import("./kb/commands.js");
    await runKbIngestUrl(String(opts.url), {
      ...kbCtx(opts),
      description: opts.description as string | undefined,
      ownerTeamSlug: opts.ownerTeamSlug as string | undefined,
    });
  });

kbIngestCmd
  .command("file <paths...>")
  .description("POST /v1/ingest/local-file (markdown, text, pdf)")
  .option("--description <text>", "Datasource description")
  .option("--owner-team-slug <slug>", "Owning team for RBAC")
  .option("--chunk-size <n>", "Chunk size", "10000")
  .option("--chunk-overlap <n>", "Chunk overlap", "2000")
  .action(async (paths: string[], opts: Record<string, unknown>) => {
    const { runKbIngestFile } = await import("./kb/commands.js");
    await runKbIngestFile(paths, {
      ...kbCtx(opts),
      description: opts.description as string | undefined,
      ownerTeamSlug: opts.ownerTeamSlug as string | undefined,
      chunkSize: Number(opts.chunkSize),
      chunkOverlap: Number(opts.chunkOverlap),
    });
  });

void kbCmd;

// ---------------------------------------------------------------------------
// caipe memory
// ---------------------------------------------------------------------------
program
  .command("memory")
  .description("Manage memory files that provide persistent context to chat sessions")
  .option("--global", "Open global ~/.config/caipe/CLAUDE.md instead of project")
  .action(async (opts: Record<string, unknown>) => {
    const { runMemory } = await import("./memory/commands.js");
    await runMemory(opts);
  });

// ---------------------------------------------------------------------------
// caipe commit
// ---------------------------------------------------------------------------
program
  .command("commit")
  .description("DCO-compliant commit with AI attribution")
  .option("--install-hook", "Install prepare-commit-msg hook into current repo")
  .action(async (opts: Record<string, unknown>) => {
    const { runCommit } = await import("./commit/commands.js");
    await runCommit(opts);
  });

// ---------------------------------------------------------------------------
// Default action: open chat REPL when invoked with no subcommand
// ---------------------------------------------------------------------------
program.action(async () => {
  const { runChat } = await import("./chat/runner.js");
  await runChat({}, program.opts());
});

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[ERROR] ${msg}\n`);
  process.exit(4);
});
