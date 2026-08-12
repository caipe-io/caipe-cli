/**
 * Clean-room line editing (Apache-2.0).
 *
 * Keyboard handling follows common bash/emacs terminal conventions documented in
 * public references (e.g. bash/readline user guides). It is not derived from
 * GNU Readline source code and does not link to GPL libraries.
 */

export interface LineBuffer {
  value: string;
  cursor: number;
}

export interface LineEditSession {
  killRing: string[];
  undoStack: LineBuffer[];
  /** Ctrl+XX: saved cursor while point is at bol */
  exchangeMark: number | null;
}

export interface TerminalKey {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  return: boolean;
  escape: boolean;
  backspace: boolean;
  delete: boolean;
  tab: boolean;
}

export type LineEditSignal = "eof" | "interrupt" | "clear-screen";

export interface LineEditOutcome {
  buffer: LineBuffer;
  session: LineEditSession;
  /** Non-text side effects for the REPL host */
  signal?: LineEditSignal;
  /** True when host should run reverse-history search UI */
  beginReverseSearch?: boolean;
}

const MAX_UNDO = 50;
const MAX_KILL = 20;

const WORD_CHAR = /[A-Za-z0-9_./@-]/;

export function createLineEditSession(): LineEditSession {
  return { killRing: [], undoStack: [], exchangeMark: null };
}

export function prevWordBoundary(value: string, pos: number): number {
  let i = pos;
  while (i > 0 && !WORD_CHAR.test(value[i - 1] ?? "")) i--;
  while (i > 0 && WORD_CHAR.test(value[i - 1] ?? "")) i--;
  return i;
}

export function nextWordBoundary(value: string, pos: number): number {
  let i = pos;
  while (i < value.length && !WORD_CHAR.test(value[i] ?? "")) i++;
  while (i < value.length && WORD_CHAR.test(value[i] ?? "")) i++;
  return i;
}

export function lastWordFromHistoryLine(line: string): string {
  const trimmed = line.trimEnd();
  const m = trimmed.match(/(\S+)\s*$/);
  return m?.[1] ?? "";
}

function clampCursor(buffer: LineBuffer): LineBuffer {
  const cursor = Math.max(0, Math.min(buffer.cursor, buffer.value.length));
  return cursor === buffer.cursor ? buffer : { ...buffer, cursor };
}

function withUndo(session: LineEditSession, before: LineBuffer): LineEditSession {
  const undoStack = [...session.undoStack, { value: before.value, cursor: before.cursor }].slice(
    -MAX_UNDO,
  );
  return { ...session, undoStack };
}

function pushKill(session: LineEditSession, killed: string): LineEditSession {
  if (!killed) return session;
  const killRing = [killed, ...session.killRing.filter((k) => k !== killed)].slice(0, MAX_KILL);
  return { ...session, killRing };
}

function applyBuffer(
  session: LineEditSession,
  before: LineBuffer,
  next: LineBuffer,
  killed?: string,
): LineEditOutcome {
  let s = withUndo(session, before);
  if (killed) s = pushKill(s, killed);
  return { buffer: clampCursor(next), session: s };
}

export function undoEdit(session: LineEditSession, _current: LineBuffer): LineEditOutcome | null {
  if (session.undoStack.length === 0) return null;
  const undoStack = [...session.undoStack];
  const prev = undoStack.pop()!;
  return {
    buffer: clampCursor(prev),
    session: { ...session, undoStack },
  };
}

export function insertText(buffer: LineBuffer, text: string): LineBuffer {
  const { value, cursor } = buffer;
  const next = value.slice(0, cursor) + text + value.slice(cursor);
  return { value: next, cursor: cursor + text.length };
}

export function deleteBackward(buffer: LineBuffer): LineBuffer {
  if (buffer.cursor <= 0) return buffer;
  const { value, cursor } = buffer;
  return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
}

export function deleteForward(buffer: LineBuffer): LineBuffer {
  if (buffer.cursor >= buffer.value.length) return buffer;
  const { value, cursor } = buffer;
  return { value: value.slice(0, cursor) + value.slice(cursor + 1), cursor };
}

export function killToStart(buffer: LineBuffer): { buffer: LineBuffer; killed: string } {
  const killed = buffer.value.slice(0, buffer.cursor);
  return {
    killed,
    buffer: { value: buffer.value.slice(buffer.cursor), cursor: 0 },
  };
}

export function killToEnd(buffer: LineBuffer): { buffer: LineBuffer; killed: string } {
  const killed = buffer.value.slice(buffer.cursor);
  return {
    killed,
    buffer: { value: buffer.value.slice(0, buffer.cursor), cursor: buffer.cursor },
  };
}

export function killWordBackward(buffer: LineBuffer): { buffer: LineBuffer; killed: string } {
  const start = prevWordBoundary(buffer.value, buffer.cursor);
  const killed = buffer.value.slice(start, buffer.cursor);
  return {
    killed,
    buffer: {
      value: buffer.value.slice(0, start) + buffer.value.slice(buffer.cursor),
      cursor: start,
    },
  };
}

export function killWordForward(buffer: LineBuffer): { buffer: LineBuffer; killed: string } {
  const end = nextWordBoundary(buffer.value, buffer.cursor);
  const killed = buffer.value.slice(buffer.cursor, end);
  return {
    killed,
    buffer: {
      value: buffer.value.slice(0, buffer.cursor) + buffer.value.slice(end),
      cursor: buffer.cursor,
    },
  };
}

export function yankAtCursor(buffer: LineBuffer, session: LineEditSession): LineEditOutcome | null {
  const paste = session.killRing[0];
  if (!paste) return null;
  const next = insertText(buffer, paste);
  return { buffer: next, session };
}

export function yankPopAtCursor(
  buffer: LineBuffer,
  session: LineEditSession,
): LineEditOutcome | null {
  if (session.killRing.length < 2) return yankAtCursor(buffer, session);
  const [_, ...rest] = session.killRing;
  const rotated = [...rest, session.killRing[0]!];
  const paste = rotated[0]!;
  const next = insertText(buffer, paste);
  return { buffer: next, session: { ...session, killRing: rotated } };
}

export function transposeChars(buffer: LineBuffer): LineBuffer {
  const { value, cursor } = buffer;
  if (cursor === 0 || value.length < 2) return buffer;
  const i = cursor >= value.length ? value.length - 1 : cursor;
  if (i === 0) return buffer;
  const chars = value.split("");
  const a = chars[i - 1]!;
  const b = chars[i]!;
  chars[i - 1] = b;
  chars[i] = a;
  return { value: chars.join(""), cursor: cursor === value.length ? cursor : cursor + 1 };
}

function transformWord(
  buffer: LineBuffer,
  fn: (word: string) => string,
): { buffer: LineBuffer; changed: boolean } {
  const { value, cursor } = buffer;
  const start = prevWordBoundary(value, cursor);
  const end = nextWordBoundary(value, cursor);
  if (start === end) return { buffer, changed: false };
  const word = value.slice(start, end);
  const replaced = fn(word);
  return {
    changed: true,
    buffer: {
      value: value.slice(0, start) + replaced + value.slice(end),
      cursor: start + replaced.length,
    },
  };
}

export function capitalizeWord(buffer: LineBuffer): LineBuffer {
  const r = transformWord(buffer, (w) => w.charAt(0).toUpperCase() + w.slice(1));
  return r.changed ? r.buffer : buffer;
}

export function upcaseWord(buffer: LineBuffer): LineBuffer {
  const r = transformWord(buffer, (w) => w.toUpperCase());
  return r.changed ? r.buffer : buffer;
}

export function downcaseWord(buffer: LineBuffer): LineBuffer {
  const r = transformWord(buffer, (w) => w.toLowerCase());
  return r.changed ? r.buffer : buffer;
}

export function exchangePointAndMark(
  buffer: LineBuffer,
  session: LineEditSession,
): LineEditOutcome {
  if (session.exchangeMark === null) {
    return {
      buffer: { ...buffer, cursor: 0 },
      session: { ...session, exchangeMark: buffer.cursor },
    };
  }
  return {
    buffer: { ...buffer, cursor: session.exchangeMark },
    session: { ...session, exchangeMark: null },
  };
}

/**
 * Apply a single key event to the line buffer (Ink raw-mode key object).
 * Navigation keys that depend on REPL history or slash picker return null — host handles those.
 */
export function applyLineEditKey(
  buffer: LineBuffer,
  session: LineEditSession,
  char: string,
  key: TerminalKey,
): LineEditOutcome | null {
  if (key.ctrl && !key.meta) {
    switch (char) {
      case "a":
        return { buffer: { ...buffer, cursor: 0 }, session };
      case "e":
        return { buffer: { ...buffer, cursor: buffer.value.length }, session };
      case "b":
        return { buffer: { ...buffer, cursor: Math.max(0, buffer.cursor - 1) }, session };
      case "f":
        return {
          buffer: { ...buffer, cursor: Math.min(buffer.value.length, buffer.cursor + 1) },
          session,
        };
      case "h":
        return applyBuffer(session, buffer, deleteBackward(buffer));
      case "d":
        if (buffer.value.length === 0 && buffer.cursor === 0) {
          return { buffer, session, signal: "eof" };
        }
        return applyBuffer(session, buffer, deleteForward(buffer));
      case "u": {
        const { buffer: next, killed } = killToStart(buffer);
        return applyBuffer(session, buffer, next, killed);
      }
      case "k": {
        const { buffer: next, killed } = killToEnd(buffer);
        return applyBuffer(session, buffer, next, killed);
      }
      case "w": {
        const { buffer: next, killed } = killWordBackward(buffer);
        return applyBuffer(session, buffer, next, killed);
      }
      case "t":
        return applyBuffer(session, buffer, transposeChars(buffer));
      case "y": {
        const y = yankAtCursor(buffer, session);
        return y ? applyBuffer(session, buffer, y.buffer) : { buffer, session };
      }
      case "l":
        return { buffer, session, signal: "clear-screen" };
      case "r":
        return { buffer, session, beginReverseSearch: true };
      case "g":
        return { buffer, session };
      case "c":
        return { buffer, session, signal: "interrupt" };
      case "x":
        return exchangePointAndMark(buffer, session);
      case "_":
      case "/":
        return undoEdit(session, buffer);
      default:
        return null;
    }
  }

  if (key.meta) {
    switch (char) {
      case "b":
        return {
          buffer: { ...buffer, cursor: prevWordBoundary(buffer.value, buffer.cursor) },
          session,
        };
      case "f":
        return {
          buffer: { ...buffer, cursor: nextWordBoundary(buffer.value, buffer.cursor) },
          session,
        };
      case "d": {
        const { buffer: next, killed } = killWordForward(buffer);
        return applyBuffer(session, buffer, next, killed);
      }
      case "y":
        return yankPopAtCursor(buffer, session) ?? { buffer, session };
      case "c":
        return applyBuffer(session, buffer, capitalizeWord(buffer));
      case "u":
        return applyBuffer(session, buffer, upcaseWord(buffer));
      case "l":
        return applyBuffer(session, buffer, downcaseWord(buffer));
      case ".":
        return null;
      default:
        return null;
    }
  }

  if (key.backspace || key.delete || (key.ctrl && char === "h")) {
    // Ink maps terminal DEL (0x7f, common Backspace on macOS) to key.delete, not key.backspace.
    return applyBuffer(session, buffer, deleteBackward(buffer));
  }

  if (key.leftArrow) {
    return {
      buffer: {
        ...buffer,
        cursor: key.meta
          ? prevWordBoundary(buffer.value, buffer.cursor)
          : Math.max(0, buffer.cursor - 1),
      },
      session,
    };
  }

  if (key.rightArrow) {
    return {
      buffer: {
        ...buffer,
        cursor: key.meta
          ? nextWordBoundary(buffer.value, buffer.cursor)
          : Math.min(buffer.value.length, buffer.cursor + 1),
      },
      session,
    };
  }

  if (char && !key.ctrl && !key.meta && char.length > 0 && char !== "\r") {
    if (char.length > 1) {
      return applyBuffer(session, buffer, insertText(buffer, char));
    }
    return applyBuffer(session, buffer, insertText(buffer, char));
  }

  return null;
}
