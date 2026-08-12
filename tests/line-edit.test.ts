import { describe, expect, it } from "vitest";
import {
  applyLineEditKey,
  createLineEditSession,
  deleteForward,
  killToStart,
  killWordBackward,
  lastWordFromHistoryLine,
  prevWordBoundary,
  transposeChars,
  undoEdit,
  yankAtCursor,
} from "../src/chat/line-edit.js";

describe("line-edit (clean-room)", () => {
  it("moves by word with Alt+b / Alt+f", () => {
    const buf = { value: "hello world", cursor: 11 };
    const session = createLineEditSession();
    const back = applyLineEditKey(buf, session, "b", {
      ctrl: false,
      meta: true,
      shift: false,
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      return: false,
      escape: false,
      backspace: false,
      delete: false,
      tab: false,
    });
    expect(back?.buffer.cursor).toBe(prevWordBoundary(buf.value, buf.cursor));
  });

  it("kills to start with Ctrl+u and yanks with Ctrl+y", () => {
    let buf = { value: "prefixsuffix", cursor: 6 };
    let session = createLineEditSession();
    const killed = killToStart(buf);
    const out = applyLineEditKey(buf, session, "u", {
      ctrl: true,
      meta: false,
      shift: false,
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      return: false,
      escape: false,
      backspace: false,
      delete: false,
      tab: false,
    });
    expect(out?.buffer.value).toBe("suffix");
    expect(out?.buffer.cursor).toBe(0);
    session = out!.session;
    buf = out!.buffer;
    const y = applyLineEditKey(buf, session, "y", {
      ctrl: true,
      meta: false,
      shift: false,
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      return: false,
      escape: false,
      backspace: false,
      delete: false,
      tab: false,
    });
    expect(y?.buffer.value).toBe(`${killed.killed}suffix`);
  });

  it("deletes forward with Ctrl+d when line is non-empty", () => {
    const buf = { value: "ab", cursor: 0 };
    const next = deleteForward(buf);
    expect(next.value).toBe("b");
  });

  it("maps Ink key.delete (terminal DEL / Backspace) to delete backward", () => {
    const buf = { value: "abc", cursor: 3 };
    const out = applyLineEditKey(buf, createLineEditSession(), "", {
      ctrl: false,
      meta: false,
      shift: false,
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      return: false,
      escape: false,
      backspace: false,
      delete: true,
      tab: false,
    });
    expect(out?.buffer.value).toBe("ab");
    expect(out?.buffer.cursor).toBe(2);
  });

  it("signals eof on Ctrl+d with empty line", () => {
    const out = applyLineEditKey({ value: "", cursor: 0 }, createLineEditSession(), "d", {
      ctrl: true,
      meta: false,
      shift: false,
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      return: false,
      escape: false,
      backspace: false,
      delete: false,
      tab: false,
    });
    expect(out?.signal).toBe("eof");
  });

  it("transposes characters with Ctrl+t", () => {
    const buf = { value: "ab", cursor: 2 };
    expect(transposeChars(buf).value).toBe("ba");
  });

  it("undoes edits with Ctrl+_", () => {
    let session = createLineEditSession();
    const before = { value: "hello", cursor: 5 };
    const edited = applyLineEditKey(before, session, "u", {
      ctrl: true,
      meta: false,
      shift: false,
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      return: false,
      escape: false,
      backspace: false,
      delete: false,
      tab: false,
    });
    session = edited!.session;
    const undone = undoEdit(session, edited!.buffer);
    expect(undone?.buffer.value).toBe("hello");
  });

  it("kills word backward with Ctrl+w", () => {
    const buf = { value: "one two three", cursor: 13 };
    const { buffer } = killWordBackward(buf);
    expect(buffer.value).toBe("one two ");
  });

  it("extracts last history word for Alt+.", () => {
    expect(lastWordFromHistoryLine("show my jiras please")).toBe("please");
  });

  it("yank uses kill ring head", () => {
    const session = { killRing: ["paste"], undoStack: [], exchangeMark: null };
    const y = yankAtCursor({ value: "", cursor: 0 }, session);
    expect(y?.buffer.value).toBe("paste");
  });
});
