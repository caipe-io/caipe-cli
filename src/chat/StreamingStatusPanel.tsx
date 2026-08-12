/**
 * Streaming footer isolated from Static scrollback so timer ticks do not re-render history.
 */

import { Box } from "ink";
import type React from "react";
import { memo, useEffect, useState } from "react";

import { StreamWaitLine, ToolActivityPanel, type ToolActivityRun } from "../platform/display.js";
import { maxLiveToolTreeRows, waitStatusTickMs } from "../platform/terminal/repl-ui.js";

export type LiveToolRefEntry = {
  name: string;
  detail?: string;
  toolCallId?: string;
  startedAt: number;
};

export interface StreamingStatusPanelProps {
  active: boolean;
  liveToolsRef: React.RefObject<LiveToolRefEntry[]>;
  turnToolRunsRef: React.RefObject<ToolActivityRun[]>;
  streamStartRef: React.RefObject<number>;
  streamTokenRef: React.RefObject<number>;
  streamPhaseRef: React.RefObject<"thinking" | "generating">;
}

function snapshotLiveTools(ref: React.RefObject<LiveToolRefEntry[]>): ToolActivityRun[] {
  return (ref.current ?? []).map((t) => ({ name: t.name, detail: t.detail }));
}

function StreamingStatusPanelInner({
  active,
  liveToolsRef,
  turnToolRunsRef,
  streamStartRef,
  streamTokenRef,
  streamPhaseRef,
}: StreamingStatusPanelProps): React.ReactElement | null {
  const [elapsed, setElapsed] = useState(0);
  const [tokenCount, setTokenCount] = useState(0);
  const [phase, setPhase] = useState<"thinking" | "generating">("generating");
  const [liveTools, setLiveTools] = useState<ToolActivityRun[]>([]);
  const [completedEarlier, setCompletedEarlier] = useState(0);

  useEffect(() => {
    if (!active) {
      setElapsed(0);
      setTokenCount(0);
      setPhase("generating");
      setLiveTools([]);
      setCompletedEarlier(0);
      return;
    }
    const tick = () => {
      const start = streamStartRef.current ?? Date.now();
      setElapsed(Math.floor((Date.now() - start) / 1000));
      setTokenCount(streamTokenRef.current ?? 0);
      setPhase(streamPhaseRef.current ?? "generating");
      setLiveTools(snapshotLiveTools(liveToolsRef));
      setCompletedEarlier(turnToolRunsRef.current?.length ?? 0);
    };
    tick();
    const id = setInterval(tick, waitStatusTickMs());
    return () => clearInterval(id);
  }, [active, liveToolsRef, turnToolRunsRef, streamStartRef, streamTokenRef, streamPhaseRef]);

  if (!active) return null;

  const label = phase === "thinking" ? "Musing" : "Warping";
  const showTools = liveTools.length > 0 || completedEarlier > 0;

  return (
    <Box paddingX={1} marginBottom={1} flexDirection="column">
      {showTools ? (
        <ToolActivityPanel
          phase="running"
          runs={liveTools}
          elapsed={elapsed}
          completedEarlier={completedEarlier}
          maxTreeRows={maxLiveToolTreeRows()}
        />
      ) : null}
      <StreamWaitLine elapsed={elapsed} label={label} tokenCount={tokenCount} />
    </Box>
  );
}

export const StreamingStatusPanel = memo(StreamingStatusPanelInner);
