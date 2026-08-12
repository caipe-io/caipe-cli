/**
 * Display utilities: ASCII logo, spinners, and progress indicators.
 *
 * All output respects NO_COLOR.  The logo is printed once at interactive
 * session startup.  Spinners are React/Ink components used in the REPL.
 */

import { Box, Text } from "ink";
import React from "react";

const NO_COLOR = Boolean(process.env.NO_COLOR);

// ---------------------------------------------------------------------------
// ASCII logo
// ---------------------------------------------------------------------------

const LOGO_LINES = [
  "  ██████╗ █████╗ ██╗██████╗ ███████╗",
  " ██╔════╝██╔══██╗██║██╔══██╗██╔════╝",
  " ██║     ███████║██║██████╔╝█████╗  ",
  " ██║     ██╔══██║██║██╔═══╝ ██╔══╝  ",
  " ╚██████╗██║  ██║██║██║     ███████╗",
  "  ╚═════╝╚═╝  ╚═╝╚═╝╚═╝     ╚══════╝",
];

const TAGLINE = "Custom Agents, workflows and more... caipe.io";
const CYAN = NO_COLOR ? "" : "\x1b[96m";
const RESET = NO_COLOR ? "" : "\x1b[0m";

/**
 * Print the CAIPE ASCII logo to stdout.
 * Called once when an interactive chat session starts.
 */
export function printLogo(): void {
  if (NO_COLOR) {
    process.stdout.write("CAIPE\n");
    process.stdout.write(`${TAGLINE}\n\n`);
    return;
  }
  process.stdout.write("\n");
  for (const line of LOGO_LINES) {
    process.stdout.write(`${CYAN}${line}${RESET}\n`);
  }
  process.stdout.write(`\n  ${TAGLINE}\n\n`);
}

// ---------------------------------------------------------------------------
// Ink spinner component
// ---------------------------------------------------------------------------

/**
 * CAIPE's unique spinner frames — rotating beacon quarters.
 * Evokes a "processing / broadcasting" feel for platform engineering.
 */
const CAIPE_SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];
const SPINNER_PLAIN = ["-", "\\", "|", "/"];

export interface SpinnerProps {
  /** Label shown next to the spinner */
  label: string;
  /** Override the default cyan color */
  color?: string;
}

/**
 * Animated Ink spinner component using CAIPE's unique beacon frames.
 * Falls back to ASCII when NO_COLOR is set.
 */
export function Spinner({ label, color = "cyan" }: SpinnerProps): React.ReactElement {
  const { useState, useEffect } = React;
  const frames = NO_COLOR ? SPINNER_PLAIN : CAIPE_SPINNER_FRAMES;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length);
    }, 250);
    return () => clearInterval(id);
  }, [frames.length]);

  return (
    <Box>
      <Text color={NO_COLOR ? undefined : color}>{frames[frame]} </Text>
      <Text>{label}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Streaming status spinner
// ---------------------------------------------------------------------------

export interface StreamingSpinnerProps {
  /** Action label, e.g. "Generating", "Thinking" */
  label?: string;
  /** Elapsed seconds since streaming began */
  elapsed: number;
  /** Approximate token count received so far */
  tokenCount?: number;
}

/**
 * Streaming status line:   ◐ Generating… (12s · ~340 tokens)
 *
 * Animated spinner frames + elapsed time + optional token count.
 */
export function StreamingSpinner({
  label = "Generating",
  elapsed,
  tokenCount,
}: StreamingSpinnerProps): React.ReactElement {
  const { useState, useEffect } = React;
  const frames = NO_COLOR ? SPINNER_PLAIN : CAIPE_SPINNER_FRAMES;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % frames.length), 250);
    return () => clearInterval(id);
  }, [frames.length]);

  return (
    <Box>
      <Text color={NO_COLOR ? undefined : "blue"}>{frames[frame]} </Text>
      <Text color={NO_COLOR ? undefined : "blue"}>{label}… </Text>
      <Text dimColor>
        ({elapsed}s{tokenCount !== undefined && tokenCount > 0 ? ` · ~${tokenCount} tokens` : ""})
      </Text>
    </Box>
  );
}

import { formatToolTreeLabel } from "./terminal/tool-label.js";
import { animatedWaitEnabled } from "./terminal/repl-ui.js";

const SHELL_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "run_terminal_cmd",
  "terminal",
  "exec",
  "execute",
  "command",
]);

export function isShellLikeTool(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (SHELL_TOOL_NAMES.has(n)) return true;
  return n.includes("shell") || n.includes("bash") || n.includes("terminal");
}

export interface ToolActivityRun {
  name: string;
  detail?: string;
  durationSec?: number;
}

export interface UserMessageBarProps {
  text: string;
  width: number;
}

/** Full-width dim band for the user's prompt (Claude Code–style). */
export function UserMessageBar({ text, width }: UserMessageBarProps): React.ReactElement {
  return (
    <Box width={width} marginBottom={1}>
      <Box width={width} backgroundColor={NO_COLOR ? undefined : "gray"} paddingX={1}>
        <Text wrap="wrap">
          <Text bold={!NO_COLOR}>{"> "}</Text>
          <Text>{text}</Text>
        </Text>
      </Box>
    </Box>
  );
}

export interface RecapLineProps {
  text: string;
}

export function RecapLine({ text }: RecapLineProps): React.ReactElement {
  return (
    <Box paddingX={1} marginBottom={0}>
      <Text dimColor wrap="wrap">
        * Recap: {text}
      </Text>
    </Box>
  );
}

export interface ToolActivityPanelProps {
  phase: "running" | "done";
  runs: ToolActivityRun[];
  elapsed: number;
  /** Completed earlier in this turn (live footer only). */
  completedEarlier?: number;
  /** Hide tree rows beyond maxTreeRows (0 = summary only). */
  maxTreeRows?: number;
  /** Tools omitted from `runs` (shown as "N earlier…"). */
  omittedCount?: number;
}

function shellSummaryLabel(count: number, shellCount: number): string {
  if (shellCount === count && count > 0) {
    return count === 1 ? "shell command" : "shell commands";
  }
  return count === 1 ? "tool" : "tools";
}

/**
 * Summary row plus optional tree of shell commands (Claude Code–style).
 */
export function ToolActivityPanel({
  phase,
  runs,
  elapsed,
  completedEarlier = 0,
  maxTreeRows = Number.POSITIVE_INFINITY,
  omittedCount = 0,
}: ToolActivityPanelProps): React.ReactElement {
  const { useState, useEffect } = React;
  const frames = NO_COLOR ? SPINNER_PLAIN : CAIPE_SPINNER_FRAMES;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (phase !== "running" || !animatedWaitEnabled()) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % frames.length), 250);
    return () => clearInterval(id);
  }, [phase, frames.length]);

  const shellCount = runs.filter((r) => isShellLikeTool(r.name)).length;
  const noun = shellSummaryLabel(runs.length, shellCount);
  const summary =
    phase === "running"
      ? runs.length === 0 && completedEarlier > 0
        ? `Running… (${completedEarlier} done)`
        : completedEarlier > 0
          ? `Running ${runs.length} ${noun}… (${completedEarlier} done)`
          : `Running ${runs.length} ${noun}…`
      : omittedCount > 0
        ? `Ran ${runs.length + omittedCount} ${noun} · ${elapsed}s`
        : `Ran ${runs.length} ${noun} · ${elapsed}s`;

  const treeCap =
    maxTreeRows === Number.POSITIVE_INFINITY ? runs.length : Math.max(0, maxTreeRows);
  const treeRuns = treeCap >= runs.length ? runs : runs.slice(-treeCap);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box paddingX={1}>
        {phase === "running" && animatedWaitEnabled() ? (
          <Text color={NO_COLOR ? undefined : "yellow"}>{frames[frame]} </Text>
        ) : phase === "running" ? (
          <Text color={NO_COLOR ? undefined : "yellow"}>● </Text>
        ) : (
          <Text dimColor>● </Text>
        )}
        <Text color={phase === "running" && !NO_COLOR ? "yellow" : undefined} dimColor={phase === "done"}>
          {summary}
        </Text>
      </Box>
      {omittedCount > 0 ? (
        <Box paddingX={1} marginLeft={2}>
          <Text dimColor>… {omittedCount} earlier {omittedCount === 1 ? "tool" : "tools"}</Text>
        </Box>
      ) : null}
      {treeRuns.map((run, idx) => {
        const isLast = idx === treeRuns.length - 1;
        const branch = isLast ? "└" : "├";
        const label = formatToolTreeLabel(run.name, run.detail);
        const isUpdate = label.startsWith("Update(");
        return (
          <Box key={`${run.name}-${idx}`} paddingX={1} marginLeft={2}>
            <Text dimColor>
              {branch}{" "}
              {isUpdate ? (
                <>
                  <Text color={NO_COLOR ? undefined : "green"}>● </Text>
                  <Text color={NO_COLOR ? undefined : "green"}>{label}</Text>
                </>
              ) : (
                <>
                  ${" "}
                  <Text color={NO_COLOR ? undefined : "cyan"}>{label}</Text>
                </>
              )}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Tool run status (streaming footer)
// ---------------------------------------------------------------------------

export interface ToolRunInfo {
  id: number;
  name: string;
  startedAt: number;
}

export interface ToolRunStatusProps {
  runs: ToolRunInfo[];
  /** Seconds since the overall stream started */
  streamElapsed: number;
}

/**
 * In-stream wait line (no partial markdown): * Thinking… (12s · ↓ 340 tokens)
 */
export interface StreamWaitLineProps {
  label?: string;
  elapsed: number;
  tokenCount?: number;
}

export function StreamWaitLine({
  label = "Thinking",
  elapsed,
  tokenCount,
}: StreamWaitLineProps): React.ReactElement {
  const { useState, useEffect } = React;
  const frames = NO_COLOR ? SPINNER_PLAIN : ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!animatedWaitEnabled()) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % frames.length), 80);
    return () => clearInterval(id);
  }, [frames.length]);

  const tokenSuffix =
    tokenCount !== undefined && tokenCount > 0 ? ` · ↓ ${tokenCount} tokens` : "";

  return (
    <Box>
      <Text color={NO_COLOR ? undefined : "magenta"}>* </Text>
      {animatedWaitEnabled() ? (
        <Text color={NO_COLOR ? undefined : "magenta"}>{frames[frame]} </Text>
      ) : (
        <Text color={NO_COLOR ? undefined : "magenta"}>● </Text>
      )}
      <Text>{label}… </Text>
      <Text dimColor>
        ({elapsed}s{tokenSuffix})
      </Text>
    </Box>
  );
}

/**
 * Footer line while tools are active: "◐ Running 2 tools · read_file, bash · 12s"
 */
export function ToolRunStatus({ runs, streamElapsed }: ToolRunStatusProps): React.ReactElement {
  const { useState, useEffect } = React;
  const frames = NO_COLOR ? SPINNER_PLAIN : CAIPE_SPINNER_FRAMES;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % frames.length), 250);
    return () => clearInterval(id);
  }, [frames.length]);

  if (runs.length === 0) {
    return (
      <Box>
        <Text dimColor>({streamElapsed}s)</Text>
      </Box>
    );
  }

  const label =
    runs.length === 1
      ? `Running tool · ${runs[0]?.name ?? "unknown"}`
      : `Running ${runs.length} tools · ${runs.map((r) => r.name).join(", ")}`;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={NO_COLOR ? undefined : "yellow"}>{frames[frame]} </Text>
        <Text color={NO_COLOR ? undefined : "yellow"}>{label} </Text>
        <Text dimColor>({streamElapsed}s)</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Progress bar component
// ---------------------------------------------------------------------------

export interface ProgressBarProps {
  /** Value between 0 and 1 */
  progress: number;
  /** Bar width in characters */
  width?: number;
  label?: string;
}

export function ProgressBar({ progress, width = 30, label }: ProgressBarProps): React.ReactElement {
  const filled = Math.round(Math.max(0, Math.min(1, progress)) * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const pct = `${Math.round(progress * 100)}%`;

  return (
    <Box>
      <Text color={NO_COLOR ? undefined : "cyan"}>[{bar}]</Text>
      <Text> {pct}</Text>
      {label !== undefined && <Text dimColor> {label}</Text>}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Status dots
// ---------------------------------------------------------------------------

/**
 * Returns a colored status indicator character.
 *   available  → green ●
 *   degraded   → yellow ●
 *   unavailable → red ●
 */
export function statusDot(available: boolean | "degraded"): string {
  if (NO_COLOR) return available ? "[ok]" : "[x]";
  if (available === true) return "\x1b[32m●\x1b[0m";
  if (available === "degraded") return "\x1b[33m●\x1b[0m";
  return "\x1b[31m●\x1b[0m";
}
