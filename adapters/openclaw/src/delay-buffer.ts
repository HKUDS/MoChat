export type MochatBufferedEntry = {
  rawBody: string;
  author: string;
  senderName?: string;
  senderUsername?: string;
  timestamp?: number;
  messageId?: string;
  groupId?: string;
};

export type MochatDelayFlushReason = "mention" | "timer";

export type MochatDelayFlushHandler = (
  entries: MochatBufferedEntry[],
  reason: MochatDelayFlushReason,
) => Promise<void>;

type BufferState = {
  entries: MochatBufferedEntry[];
  timer: NodeJS.Timeout | null;
  queue: Promise<void>;
  onFlush?: MochatDelayFlushHandler;
};

const buffers = new Map<string, BufferState>();

function getState(key: string): BufferState {
  const existing = buffers.get(key);
  if (existing) {
    return existing;
  }
  const created: BufferState = {
    entries: [],
    timer: null,
    queue: Promise.resolve(),
  };
  buffers.set(key, created);
  return created;
}

function enqueueTask(key: string, task: () => Promise<void>) {
  const state = getState(key);
  const previous = state.queue;
  const next = previous.then(task, task);
  state.queue = next.catch(() => undefined);
  return next;
}

function clearTimer(state: BufferState) {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

async function flushInternal(
  key: string,
  reason: MochatDelayFlushReason,
  onFlush?: MochatDelayFlushHandler,
) {
  const state = buffers.get(key);
  if (!state) {
    return;
  }
  clearTimer(state);
  if (onFlush) {
    state.onFlush = onFlush;
  }
  const entries = state.entries.slice();
  state.entries.length = 0;
  if (entries.length === 0) {
    return;
  }
  const handler = state.onFlush;
  if (!handler) {
    return;
  }
  await handler(entries, reason);
}

export async function enqueueDelayedEntry(params: {
  key: string;
  entry: MochatBufferedEntry;
  delayMs: number;
  onFlush: MochatDelayFlushHandler;
}) {
  const { key, entry, delayMs, onFlush } = params;
  await enqueueTask(key, async () => {
    const state = getState(key);
    state.onFlush = onFlush;
    state.entries.push(entry);
    clearTimer(state);
    state.timer = setTimeout(() => {
      void enqueueTask(key, () => flushInternal(key, "timer"));
    }, Math.max(0, delayMs));
  });
}

export async function flushDelayedEntries(params: {
  key: string;
  entry?: MochatBufferedEntry;
  reason: MochatDelayFlushReason;
  onFlush: MochatDelayFlushHandler;
}) {
  const { key, entry, reason, onFlush } = params;
  await enqueueTask(key, async () => {
    const state = getState(key);
    state.onFlush = onFlush;
    if (entry) {
      state.entries.push(entry);
    }
    await flushInternal(key, reason, onFlush);
  });
}

export function clearDelayedEntries(key: string) {
  const state = buffers.get(key);
  if (!state) {
    return;
  }
  clearTimer(state);
  state.entries.length = 0;
}
