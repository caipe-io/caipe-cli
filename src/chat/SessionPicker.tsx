/**
 * Interactive session picker for `/resume` in the chat REPL.
 */

import { Box, Text } from "ink";
import type React from "react";

import { getTerminalTheme } from "../platform/theme.js";
import type { SessionSummary } from "./history.js";
import { pickerWindow } from "./picker-nav.js";
import { PICKER_HINT_NAV } from "./shortcuts.js";

const ROW_SEPARATOR = "  ────────────────────────────────────────────────────────";

function formatStarted(iso: string): string {
  return iso.slice(0, 19).replace("T", " ");
}

function shortSessionId(id: string): string {
  if (id.length <= 20) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

export interface SessionPickerProps {
  sessions: SessionSummary[];
  selectedIndex: number;
  activeSessionId: string;
  filter: string;
  visibleRowCount?: number;
}

export function SessionPicker({
  sessions,
  selectedIndex,
  activeSessionId,
  filter,
  visibleRowCount = 10,
}: SessionPickerProps): React.ReactElement {
  const theme = getTerminalTheme();
  if (sessions.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.warning}
        marginX={1}
        paddingX={1}
      >
        <Text dimColor>No sessions match {filter ? `"${filter}"` : "filter"}.</Text>
      </Box>
    );
  }

  const safeIndex = Math.max(0, Math.min(selectedIndex, sessions.length - 1));
  const selected = sessions[safeIndex];
  const { start, end } = pickerWindow(sessions.length, safeIndex, visibleRowCount);
  const slice = sessions.slice(start, end);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      marginX={1}
      paddingX={1}
    >
      <Box marginBottom={0}>
        <Text bold color={theme.accent}>
          Resume session
        </Text>
        <Text dimColor>
          {` · ${PICKER_HINT_NAV}`}
          {filter ? ` · filter: "${filter}"` : " · type to filter"}
        </Text>
      </Box>
      {start > 0 ? <Text dimColor>{`  ↑ ${start} more above`}</Text> : null}
      {slice.map((s, i) => {
        const idx = start + i;
        const sel = idx === safeIndex;
        const inSession = s.sessionId === activeSessionId;
        const started = formatStarted(s.startedAt);
        const num = String(idx + 1).padStart(2, " ");
        return (
          <Box key={s.sessionId} flexDirection="column">
            {i > 0 ? <Text dimColor>{ROW_SEPARATOR}</Text> : null}
            <Box flexDirection="column">
              <Box>
                <Text bold={sel} color={sel ? theme.accent : undefined} dimColor={!sel}>
                  {`${num} `}
                </Text>
                <Text color={sel ? theme.accent : undefined}>{sel ? "▶ " : "  "}</Text>
                <Text bold={sel} color={sel ? theme.accent : undefined}>
                  {shortSessionId(s.sessionId).padEnd(22)}
                </Text>
                <Text dimColor={!sel}> {s.agentName.padEnd(28).slice(0, 28)} </Text>
                <Text dimColor={!sel}>
                  {s.messageCount} msg · {started}
                </Text>
                {inSession ? <Text dimColor={!sel}> · in session</Text> : null}
              </Box>
              {sel ? (
                <Box paddingLeft={4}>
                  <Text dimColor wrap="truncate">
                    {s.sessionId}
                  </Text>
                </Box>
              ) : null}
            </Box>
          </Box>
        );
      })}
      {end < sessions.length ? (
        <Text dimColor>{`  ↓ ${sessions.length - end} more below`}</Text>
      ) : null}
      <Box marginTop={0}>
        <Text color={theme.accent} bold>
          {`${safeIndex + 1}/${sessions.length}`}
        </Text>
        <Text dimColor> · </Text>
        <Text bold color={theme.accent}>
          {selected ? shortSessionId(selected.sessionId) : ""}
        </Text>
        <Text dimColor> · Enter resume · Esc dismiss</Text>
      </Box>
    </Box>
  );
}
