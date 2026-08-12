import { describe, expect, it } from "vitest";
import { movePickerIndex, pagePickerIndex, pickerWindow } from "../src/chat/picker-nav.js";

describe("picker-nav", () => {
  it("wraps movePickerIndex", () => {
    expect(movePickerIndex(0, 5, -1)).toBe(4);
    expect(movePickerIndex(4, 5, 1)).toBe(0);
  });

  it("pages without wrapping", () => {
    expect(pagePickerIndex(7, 20, 5, 1)).toBe(12);
    expect(pagePickerIndex(2, 20, 5, -1)).toBe(0);
    expect(pagePickerIndex(18, 20, 5, 1)).toBe(19);
  });

  it("scroll window keeps selection visible", () => {
    expect(pickerWindow(30, 15, 10)).toEqual({ start: 10, end: 20 });
  });
});
