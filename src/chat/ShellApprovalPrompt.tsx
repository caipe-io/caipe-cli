import { Box, Text, useInput } from "ink";
import type React from "react";

import { getTerminalTheme } from "../platform/theme.js";
import { type ShellApprovalRequest, shellApprovalTitle } from "./shell-hitl.js";

export interface ShellApprovalPromptProps {
  request: ShellApprovalRequest;
  onApprove: () => void;
  onDeny: () => void;
}

/**
 * Blocks the REPL until the user allows or denies local shell execution.
 */
export function ShellApprovalPrompt({
  request,
  onApprove,
  onDeny,
}: ShellApprovalPromptProps): React.ReactElement {
  const theme = getTerminalTheme();
  useInput(
    (input, key) => {
      if (key.escape) {
        onDeny();
        return;
      }
      if (key.return) {
        onApprove();
        return;
      }
      const ch = input.toLowerCase();
      if (ch === "y") onApprove();
      else if (ch === "n") onDeny();
    },
    { isActive: true },
  );

  const title = shellApprovalTitle(request.kind);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warning}
      marginX={1}
      marginBottom={1}
      paddingX={1}
    >
      <Box marginBottom={1}>
        <Text bold color={theme.warning}>
          {title}
        </Text>
      </Box>
      <Box marginLeft={2} marginBottom={1}>
        <Text dimColor>└ </Text>
        <Text color={theme.accent}>$ </Text>
        <Text wrap="wrap">{request.cmd}</Text>
      </Box>
      <Text dimColor>y / Enter allow · n / Esc deny</Text>
    </Box>
  );
}
