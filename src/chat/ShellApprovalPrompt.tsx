import { Box, Text, useInput } from "ink";
import type React from "react";

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
      borderColor="yellow"
      marginX={1}
      marginBottom={1}
      paddingX={1}
    >
      <Box marginBottom={1}>
        <Text bold color="yellow">
          {title}
        </Text>
      </Box>
      <Box marginLeft={2} marginBottom={1}>
        <Text dimColor>└ </Text>
        <Text color="cyan">$ </Text>
        <Text wrap="wrap">{request.cmd}</Text>
      </Box>
      <Text dimColor>y / Enter allow · n / Esc deny</Text>
    </Box>
  );
}
