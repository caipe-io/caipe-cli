import { afterEach, describe, expect, it } from "vitest";
import {
  animatedWaitEnabled,
  maxLiveToolTreeRows,
  waitStatusTickMs,
} from "../src/platform/terminal/repl-ui.js";

describe("repl-ui", () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it("disables animated spinners by default", () => {
    delete process.env.CAIPE_SPINNER;
    expect(animatedWaitEnabled()).toBe(false);
  });

  it("enables spinners when CAIPE_SPINNER=1", () => {
    process.env.CAIPE_SPINNER = "1";
    expect(animatedWaitEnabled()).toBe(true);
    expect(waitStatusTickMs()).toBe(250);
  });

  it("uses 1s wait ticks when spinners are off", () => {
    delete process.env.CAIPE_SPINNER;
    expect(waitStatusTickMs()).toBe(1000);
  });

  it("caps live tool tree rows by default", () => {
    expect(maxLiveToolTreeRows()).toBe(2);
  });
});
