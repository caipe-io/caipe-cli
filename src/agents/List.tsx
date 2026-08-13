/**
 * Ink agent list component (T034).
 */

import { Box, Text } from "ink";
import type React from "react";
import { getTerminalTheme } from "../platform/theme.js";
import { truncateText } from "./picker.js";
import type { Agent } from "./types.js";

interface AgentListProps {
  agents: Agent[];
}

export function AgentList({ agents }: AgentListProps): React.ReactElement {
  const theme = getTerminalTheme();
  if (agents.length === 0) {
    return (
      <Box>
        <Text dimColor>No agents available.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color={theme.accent}>
          Accessible agents
        </Text>
        <Text dimColor> · {agents.length} total</Text>
      </Box>

      {agents.map((agent) => (
        <Box key={agent.name} flexDirection="column" marginBottom={1}>
          <Box>
            <Text color={agent.available ? theme.success : theme.danger}>
              {agent.available ? "✓ " : "✗ "}
            </Text>
            <Text bold>{truncateText(agent.displayName || agent.name, 64)}</Text>
          </Box>
          <Box paddingLeft={2}>
            <Text dimColor wrap="truncate">
              {agent.name} · {agent.domain} · {(agent.protocols ?? ["agui"]).join(", ")}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
