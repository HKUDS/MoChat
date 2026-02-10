import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDelayedEntries,
  enqueueDelayedEntry,
  flushDelayedEntries,
  type MochatBufferedEntry,
} from "./delay-buffer.js";

const makeEntry = (rawBody: string, author = "user"): MochatBufferedEntry => ({
  rawBody,
  author,
});

describe("mochat delay buffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes after delay and merges entries", async () => {
    const key = "session:one";
    const onFlush = vi.fn(async () => {});

    await enqueueDelayedEntry({
      key,
      entry: makeEntry("first"),
      delayMs: 1000,
      onFlush,
    });

    await vi.advanceTimersByTimeAsync(500);

    await enqueueDelayedEntry({
      key,
      entry: makeEntry("second", "user2"),
      delayMs: 1000,
      onFlush,
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(onFlush).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
    const entries = onFlush.mock.calls[0]?.[0] as MochatBufferedEntry[];
    expect(entries.map((entry) => entry.rawBody)).toEqual(["first", "second"]);

    clearDelayedEntries(key);
  });

  it("flushes immediately on mention and includes buffered entries", async () => {
    const key = "session:two";
    const onFlush = vi.fn(async () => {});

    await enqueueDelayedEntry({
      key,
      entry: makeEntry("buffered"),
      delayMs: 1000,
      onFlush,
    });

    await flushDelayedEntries({
      key,
      entry: makeEntry("@bot", "user3"),
      reason: "mention",
      onFlush,
    });

    expect(onFlush).toHaveBeenCalledTimes(1);
    const entries = onFlush.mock.calls[0]?.[0] as MochatBufferedEntry[];
    expect(entries.map((entry) => entry.rawBody)).toEqual(["buffered", "@bot"]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onFlush).toHaveBeenCalledTimes(1);

    clearDelayedEntries(key);
  });
});
