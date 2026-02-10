import fs from "node:fs/promises";
import path from "node:path";
import type { ChannelLogSink } from "openclaw/plugin-sdk";
import { io, type Socket } from "socket.io-client";
import msgpackParser from "socket.io-msgpack-parser";
import {
  getWorkspaceGroup,
  listSessions,
  type MochatEvent,
  type MochatSessionResponse,
  type MochatWatchResponse,
} from "./api.js";
import type { ResolvedMochatAccount } from "./accounts.js";
import { handleInboundMessage, type MochatStatusSink } from "./inbound.js";
import { recordPanelEvent } from "./event-store.js";
import { getMochatRuntime } from "./runtime.js";

type SubscribeAck = {
  sessions?: MochatWatchResponse[];
};

type SocketAck<T> = {
  result: boolean;
  data?: T;
  message?: string;
};

type SessionCursorMap = Record<string, number | undefined>;
type SessionSet = Set<string>;
type PanelSet = Set<string>;
type PanelInfo = {
  id: string;
  type?: number;
};

type PersistedCursorState = {
  schemaVersion: number;
  updatedAt: string;
  cursors: Record<string, number>;
};

type InboxAppendPayload = {
  _id?: string;
  type?: string;
  payload?: {
    groupId?: string;
    converseId?: string;
    messageId?: string;
    messageAuthor?: string;
    messageSnippet?: string;
    messagePlainContent?: string;
  };
  createdAt?: string;
  updatedAt?: string;
};

const PANEL_TYPE_TEXT = 0;
const CURSOR_STORE_SCHEMA_VERSION = 1;
const LEGACY_BOOTSTRAP_CURSOR = 2_147_483_647;
const CURSOR_PERSIST_DEBOUNCE_MS = 500;
const MESSAGE_DEDUPE_LIMIT = 2000;
const CONVERSE_LOOKUP_RETRY_MS = 15_000;

function resolveSocketUrl(account: ResolvedMochatAccount): string {
  const raw = account.config.socketUrl?.trim() || account.config.baseUrl;
  return raw.trim().replace(/\/+$/, "");
}

function resolveCursorStorePath(accountId: string): string {
  const runtime = getMochatRuntime();
  const stateDir = runtime.state.resolveStateDir();
  return path.join(stateDir, "mochat", "cursors", `${accountId}.json`);
}

async function loadPersistedCursors(params: {
  accountId: string;
  log?: ChannelLogSink;
}): Promise<Map<string, number>> {
  const filePath = resolveCursorStorePath(params.accountId);
  let text = "";
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      return new Map<string, number>();
    }
    params.log?.error?.(
      `mochat: failed reading cursor store for ${params.accountId}: ${String(err)}`,
    );
    return new Map<string, number>();
  }

  try {
    const parsed = JSON.parse(text) as PersistedCursorState;
    if (!parsed || typeof parsed !== "object" || !parsed.cursors) {
      return new Map<string, number>();
    }
    const next = new Map<string, number>();
    for (const [sessionId, rawCursor] of Object.entries(parsed.cursors)) {
      if (typeof rawCursor !== "number" || !Number.isFinite(rawCursor) || rawCursor < 0) {
        continue;
      }
      if (rawCursor >= LEGACY_BOOTSTRAP_CURSOR) {
        continue;
      }
      next.set(String(sessionId), Math.floor(rawCursor));
    }
    return next;
  } catch (err) {
    params.log?.error?.(
      `mochat: failed parsing cursor store for ${params.accountId}: ${String(err)}`,
    );
    return new Map<string, number>();
  }
}

async function persistCursors(params: {
  accountId: string;
  cursorBySession: Map<string, number>;
  log?: ChannelLogSink;
}) {
  const filePath = resolveCursorStorePath(params.accountId);
  const cursors: Record<string, number> = {};
  for (const [sessionId, cursor] of params.cursorBySession.entries()) {
    if (typeof cursor !== "number" || !Number.isFinite(cursor) || cursor < 0) {
      continue;
    }
    if (cursor >= LEGACY_BOOTSTRAP_CURSOR) {
      continue;
    }
    cursors[sessionId] = Math.floor(cursor);
  }
  const payload: PersistedCursorState = {
    schemaVersion: CURSOR_STORE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    cursors,
  };

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (err) {
    params.log?.error?.(
      `mochat: failed writing cursor store for ${params.accountId}: ${String(err)}`,
    );
  }
}

function collectCursors(cursorBySession: Map<string, number>): SessionCursorMap {
  const snapshot: SessionCursorMap = {};
  for (const [sessionId, cursor] of cursorBySession.entries()) {
    snapshot[sessionId] = cursor;
  }
  return snapshot;
}

function normalizeSessions(data: unknown): MochatWatchResponse[] {
  if (!data) {
    return [];
  }
  if (Array.isArray(data)) {
    return data as MochatWatchResponse[];
  }
  const obj = data as SubscribeAck;
  if (Array.isArray(obj.sessions)) {
    return obj.sessions;
  }
  return [data as MochatWatchResponse];
}

function buildCursorFromPayload(
  payload: MochatWatchResponse,
  lastCursor: number,
): number {
  let nextCursor = lastCursor;
  if (typeof payload.cursor === "number") {
    nextCursor = Math.max(nextCursor, payload.cursor);
  }
  for (const event of payload.events ?? []) {
    if (typeof event.seq === "number") {
      nextCursor = Math.max(nextCursor, event.seq);
    }
  }
  return nextCursor;
}

function resolveMessageId(event: MochatEvent): string {
  const value = event?.payload?.messageId;
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return "";
}

export function startMochatSocketClient(params: {
  account: ResolvedMochatAccount;
  log?: ChannelLogSink;
  abortSignal: AbortSignal;
  statusSink?: MochatStatusSink;
}) {
  const { account, log, abortSignal, statusSink } = params;
  const socketUrl = resolveSocketUrl(account);
  const cursorBySession = new Map<string, number>();
  const coldSessionSet: SessionSet = new Set();
  const queueBySession = new Map<string, Promise<void>>();
  const recentMessageIdQueueBySession = new Map<string, string[]>();
  const recentMessageIdSetBySession = new Map<string, Set<string>>();
  const sessionIdByConverseId = new Map<string, string>();
  const converseLookupRetryAt = new Map<string, number>();
  const explicitSessions = account.config.sessions ?? [];
  const explicitPanels = account.config.panels ?? [];
  const autoDiscoverSessions = account.config.autoDiscoverSessions;
  const autoDiscoverPanels = account.config.autoDiscoverPanels;
  const refreshIntervalMs = account.config.refreshIntervalMs;
  const sessionSet: SessionSet = new Set(explicitSessions.map((id) => String(id)));
  const panelSet: PanelSet = new Set(explicitPanels.map((id) => String(id)));
  let refreshTimer: NodeJS.Timeout | null = null;
  let cursorPersistTimer: NodeJS.Timeout | null = null;
  let cursorPersistQueue: Promise<void> = Promise.resolve();
  let stopped = false;

  const trackSessionDirectory = (
    sessions: MochatSessionResponse[],
  ): { newSessions: string[]; mappedConverse: number } => {
    const newSessions: string[] = [];
    let mappedConverse = 0;
    for (const session of sessions) {
      const sessionId =
        typeof session?.sessionId === "string" ? session.sessionId.trim() : "";
      if (!sessionId) {
        continue;
      }
      if (!sessionSet.has(sessionId)) {
        sessionSet.add(sessionId);
        newSessions.push(sessionId);
      }
      const converseId =
        typeof session?.converseId === "string" ? session.converseId.trim() : "";
      if (converseId) {
        sessionIdByConverseId.set(converseId, sessionId);
        mappedConverse += 1;
      }
    }
    return { newSessions, mappedConverse };
  };

  const rememberMessageId = (sessionId: string, messageId: string): boolean => {
    if (!messageId) {
      return false;
    }
    let seenSet = recentMessageIdSetBySession.get(sessionId);
    let queue = recentMessageIdQueueBySession.get(sessionId);
    if (!seenSet || !queue) {
      seenSet = new Set<string>();
      queue = [];
      recentMessageIdSetBySession.set(sessionId, seenSet);
      recentMessageIdQueueBySession.set(sessionId, queue);
    }

    if (seenSet.has(messageId)) {
      return true;
    }

    seenSet.add(messageId);
    queue.push(messageId);
    if (queue.length > MESSAGE_DEDUPE_LIMIT) {
      const removed = queue.shift();
      if (removed) {
        seenSet.delete(removed);
      }
    }
    return false;
  };

  const flushCursorPersist = async () => {
    if (cursorPersistTimer) {
      clearTimeout(cursorPersistTimer);
      cursorPersistTimer = null;
    }
    cursorPersistQueue = cursorPersistQueue.then(async () => {
      await persistCursors({
        accountId: account.accountId,
        cursorBySession,
        log,
      });
    });
    await cursorPersistQueue;
  };

  const scheduleCursorPersist = () => {
    if (stopped || cursorPersistTimer) {
      return;
    }
    cursorPersistTimer = setTimeout(() => {
      cursorPersistTimer = null;
      cursorPersistQueue = cursorPersistQueue.then(async () => {
        await persistCursors({
          accountId: account.accountId,
          cursorBySession,
          log,
        });
      });
    }, CURSOR_PERSIST_DEBOUNCE_MS);
  };

  const enqueue = (sessionId: string, task: () => Promise<void>) => {
    const previous = queueBySession.get(sessionId) ?? Promise.resolve();
    const next = previous.then(task, task);
    queueBySession.set(sessionId, next.catch(() => {}));
  };

  const applyEvents = (
    payload: MochatWatchResponse,
    targetKind: "session" | "panel" = "session",
  ) => {
    const sessionId = payload.sessionId;
    if (!sessionId) {
      return;
    }

    const lastCursor = cursorBySession.get(sessionId) ?? 0;
    const payloadCursor =
      typeof payload.cursor === "number" && Number.isFinite(payload.cursor)
        ? payload.cursor
        : undefined;
    const cursorRegressed =
      typeof payloadCursor === "number" && payloadCursor < lastCursor;
    if (cursorRegressed) {
      log?.info?.(
        `mochat: cursor regressed for ${sessionId} (last=${lastCursor}, payload=${payloadCursor}); using dedupe-first mode`,
      );
    }
    const isColdSession = targetKind === "session" && coldSessionSet.has(sessionId);
    const nextCursor = cursorRegressed
      ? Math.max(0, Math.floor(payloadCursor ?? 0))
      : buildCursorFromPayload(payload, lastCursor);
    cursorBySession.set(sessionId, nextCursor);
    scheduleCursorPersist();

    if (isColdSession) {
      coldSessionSet.delete(sessionId);
      if ((payload.events ?? []).length > 0) {
        log?.info?.(
          `mochat: skipped historical bootstrap events for ${sessionId} (${(payload.events ?? []).length} events)`,
        );
      }
      return;
    }

    const rawEvents = payload.events ?? [];
    const events = rawEvents.filter((event) => {
      if (cursorRegressed) {
        return true;
      }
      if (typeof event.seq === "number") {
        return event.seq > lastCursor;
      }
      return true;
    });
    if (events.length === 0) {
      if (targetKind === "session" && rawEvents.length > 0) {
        const seqs = rawEvents
          .map((event) => event.seq)
          .filter((value): value is number => typeof value === "number");
        const minSeq = seqs.length > 0 ? Math.min(...seqs) : "n/a";
        const maxSeq = seqs.length > 0 ? Math.max(...seqs) : "n/a";
        log?.info?.(
          `mochat: session events filtered session=${sessionId} raw=${rawEvents.length} lastCursor=${lastCursor} payloadCursor=${payloadCursor ?? "n/a"} minSeq=${minSeq} maxSeq=${maxSeq}`,
        );
      }
      return;
    }

    enqueue(sessionId, async () => {
      for (const event of events) {
        if (event.type !== "message.add") {
          if (targetKind === "session") {
            log?.info?.(
              `mochat: session event skipped session=${sessionId} type=${event.type} seq=${typeof event.seq === "number" ? event.seq : "n/a"}`,
            );
          }
          continue;
        }
        const messageId = resolveMessageId(event as MochatEvent);
        if (messageId && rememberMessageId(sessionId, messageId)) {
          if (targetKind === "session") {
            log?.info?.(
              `mochat: session event deduped session=${sessionId} mid=${messageId} seq=${typeof event.seq === "number" ? event.seq : "n/a"}`,
            );
          }
          continue;
        }
        if (targetKind === "session") {
          log?.info?.(
            `mochat: session event accepted session=${sessionId} mid=${messageId || "n/a"} seq=${typeof event.seq === "number" ? event.seq : "n/a"} author=${String((event as MochatEvent)?.payload?.author ?? "")}`,
          );
        }
        try {
          await handleInboundMessage({
            account,
            sessionId,
            event: event as MochatEvent,
            targetKind,
            log,
            statusSink,
          });
        } catch (err) {
          log?.error?.(`mochat: socket event failed for ${sessionId}: ${String(err)}`);
        }
      }
    });
  };

  const subscribeSessions = (socket: Socket, sessionIds: string[]) => {
    if (sessionIds.length === 0) {
      return;
    }

    const cursors = collectCursors(cursorBySession);
    for (const sessionId of sessionIds) {
      if (typeof cursors[sessionId] !== "number") {
        coldSessionSet.add(sessionId);
      }
    }

    socket.emit(
      "com.claw.im.subscribeSessions",
      {
        sessionIds,
        cursors,
        limit: account.config.watchLimit,
      },
      (ack: SocketAck<SubscribeAck>) => {
        if (!ack?.result) {
          const message = ack?.message ?? "subscribe failed";
          log?.error?.(`mochat: subscribe failed: ${message}`);
          statusSink?.({ lastError: message });
          return;
        }
        for (const session of normalizeSessions(ack.data)) {
          applyEvents(session);
        }
      },
    );
  };

  const subscribePanels = (socket: Socket, panelIds: string[]) => {
    if (!autoDiscoverPanels && panelIds.length === 0) {
      return;
    }
    socket.emit(
      "com.claw.im.subscribePanels",
      {
        panelIds,
      },
      (ack: SocketAck<{ panelIds?: string[]; groupId?: string }>) => {
        if (!ack?.result) {
          const message = ack?.message ?? "subscribe panels failed";
          log?.error?.(`mochat: panel subscribe failed: ${message}`);
          statusSink?.({ lastError: message });
        }
      },
    );
  };

  const refreshSessionDirectory = async (socket: Socket | null, reason: string) => {
    const response = await listSessions({
      baseUrl: account.config.baseUrl,
      clawToken: account.config.clawToken ?? "",
    });
    const sessions = response.sessions ?? [];
    const { newSessions, mappedConverse } = trackSessionDirectory(sessions);
    if (newSessions.length > 0 && socket) {
      subscribeSessions(socket, newSessions);
    }
    if (newSessions.length > 0 || mappedConverse > 0) {
      log?.info?.(
        `mochat: session directory refreshed (${reason}): sessions=${sessions.length}, new=${newSessions.length}, converseMapped=${mappedConverse}`,
      );
    }
  };

  const resolveSessionIdByConverse = async (
    socket: Socket,
    converseId: string,
  ): Promise<string | undefined> => {
    const cached = sessionIdByConverseId.get(converseId);
    if (cached) {
      return cached;
    }

    const now = Date.now();
    const nextRetryAt = converseLookupRetryAt.get(converseId) ?? 0;
    if (nextRetryAt > now) {
      return undefined;
    }
    converseLookupRetryAt.set(converseId, now + CONVERSE_LOOKUP_RETRY_MS);

    try {
      await refreshSessionDirectory(socket, `resolve-converse:${converseId}`);
    } catch (err) {
      log?.error?.(
        `mochat: failed resolving converse ${converseId}: ${String(err)}`,
      );
      return undefined;
    }

    return sessionIdByConverseId.get(converseId);
  };

  const refreshSessions = async (socket: Socket) => {
    if (!autoDiscoverSessions) {
      return;
    }
    try {
      await refreshSessionDirectory(socket, "auto-discover");
    } catch (err) {
      log?.error?.(`mochat: session refresh failed: ${String(err)}`);
    }
  };

  const resolveTextPanels = (panels?: PanelInfo[]) => {
    if (!Array.isArray(panels)) {
      return [];
    }
    return panels
      .filter((panel) => {
        if (!panel) {
          return false;
        }
        if (typeof panel.type === "number" && panel.type !== PANEL_TYPE_TEXT) {
          return false;
        }
        return Boolean(panel.id);
      })
      .map((panel) => String(panel.id));
  };

  const refreshPanels = async (socket: Socket) => {
    if (!autoDiscoverPanels) {
      return;
    }
    try {
      const groupInfo = await getWorkspaceGroup({
        baseUrl: account.config.baseUrl,
        clawToken: account.config.clawToken ?? "",
      });
      const rawPanels = Array.isArray(groupInfo.panels) ? groupInfo.panels : [];
      const panels = resolveTextPanels(
        rawPanels.map((panel) => ({
          id: String((panel as any)?.id ?? (panel as any)?._id ?? ""),
          type: (panel as any)?.type,
        })),
      );
      const newPanels: string[] = [];
      for (const panelId of panels) {
        if (!panelSet.has(panelId)) {
          panelSet.add(panelId);
          newPanels.push(panelId);
        }
      }
      subscribePanels(socket, newPanels);
    } catch (err) {
      log?.error?.(`mochat: panel refresh failed: ${String(err)}`);
    }
  };

  const refreshTargets = async (socket: Socket) => {
    await Promise.all([refreshSessions(socket), refreshPanels(socket)]);
  };

  const subscribe = (socket: Socket) => {
    subscribeSessions(socket, Array.from(sessionSet));
    subscribePanels(socket, Array.from(panelSet));
    if (autoDiscoverSessions || autoDiscoverPanels) {
      void refreshTargets(socket);
      if (refreshTimer) {
        clearInterval(refreshTimer);
      }
      refreshTimer = setInterval(() => {
        if (stopped) {
          return;
        }
        void refreshTargets(socket);
      }, refreshIntervalMs);
    }
  };

  const socket = io(socketUrl, {
    path: account.config.socketPath,
    transports: ["websocket"],
    parser: account.config.socketDisableMsgpack ? undefined : msgpackParser,
    auth: {
      token: account.config.clawToken ?? "",
    },
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts:
      account.config.maxRetryAttempts > 0 ? account.config.maxRetryAttempts : undefined,
    reconnectionDelay: account.config.socketReconnectDelayMs,
    reconnectionDelayMax: account.config.socketMaxReconnectDelayMs,
    timeout: account.config.socketConnectTimeoutMs,
  });

  socket.on("connect", () => {
    if (stopped) {
      return;
    }
    statusSink?.({ lastError: null });
    subscribe(socket);
  });

  socket.on("connect_error", (err) => {
    if (stopped) {
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log?.error?.(`mochat: socket connect failed: ${message}`);
    statusSink?.({ lastError: message });
  });

  socket.on("disconnect", (reason) => {
    if (stopped) {
      return;
    }
    log?.info?.(`mochat: socket disconnected (${reason})`);
    if (reason !== "io client disconnect") {
      statusSink?.({ lastError: reason });
    }
  });

  socket.on("claw.session.events", (payload: MochatWatchResponse) => {
    if (stopped) {
      return;
    }
    log?.info?.(
      `mochat: recv claw.session.events session=${payload?.sessionId ?? "unknown"} events=${payload?.events?.length ?? 0} cursor=${payload?.cursor ?? "n/a"}`,
    );
    applyEvents(payload);
  });

  socket.on("claw.panel.events", (payload: MochatWatchResponse) => {
    if (stopped) {
      return;
    }
    log?.info?.(
      `mochat: recv claw.panel.events panel=${payload?.sessionId ?? "unknown"} events=${payload?.events?.length ?? 0} cursor=${payload?.cursor ?? "n/a"}`,
    );
    applyEvents(payload, "panel");
  });

  socket.onAny((eventName, payload) => {
    if (stopped) {
      return;
    }
    if (typeof eventName !== "string" || !eventName.startsWith("notify:")) {
      return;
    }

    if (eventName === "notify:chat.inbox.append") {
      if (!payload || typeof payload !== "object") {
        return;
      }
      const inbox = payload as InboxAppendPayload;
      if (inbox.type !== "message") {
        return;
      }

      const detail = inbox.payload;
      if (!detail || typeof detail !== "object") {
        log?.error?.("mochat: inbox append payload missing detail object");
        return;
      }

      const converseId =
        typeof detail.converseId === "string" ? detail.converseId.trim() : "";
      if (!converseId) {
        log?.error?.("mochat: inbox append missing converseId");
        return;
      }

      const groupId = typeof detail.groupId === "string" ? detail.groupId.trim() : "";
      if (groupId) {
        log?.info?.(
          `mochat: inbox append(group) converse=${converseId} group=${groupId} mid=${detail.messageId ?? inbox._id ?? "unknown"}`,
        );
        return;
      }

      void (async () => {
        const sessionId = await resolveSessionIdByConverse(socket, converseId);
        log?.info?.(
          `mochat: inbox append(dm) converse=${converseId} session=${sessionId ?? "unknown"} mid=${detail.messageId ?? inbox._id ?? "unknown"}`,
        );
        if (!sessionId) {
          return;
        }

        const messageId =
          (typeof detail.messageId === "string" && detail.messageId.trim()) ||
          (typeof inbox._id === "string" && inbox._id.trim()) ||
          "";
        if (messageId && rememberMessageId(sessionId, messageId)) {
          log?.info?.(
            `mochat: inbox append(dm) deduped session=${sessionId} mid=${messageId}`,
          );
          return;
        }

        const author =
          typeof detail.messageAuthor === "string" ? detail.messageAuthor.trim() : "";
        if (!author) {
          log?.error?.(
            `mochat: inbox append(dm) missing messageAuthor for session=${sessionId}`,
          );
          return;
        }
        const content =
          (typeof detail.messagePlainContent === "string" &&
          detail.messagePlainContent.trim()
            ? detail.messagePlainContent
            : undefined) ??
          (typeof detail.messageSnippet === "string" ? detail.messageSnippet : "");
        const syntheticEvent: MochatEvent = {
          seq: 0,
          sessionId,
          type: "message.add",
          timestamp:
            typeof inbox.createdAt === "string" ? inbox.createdAt : new Date().toISOString(),
          payload: {
            messageId: messageId || undefined,
            author,
            content,
            meta: {
              sourceEvent: eventName,
              sourceType: "inbox-append",
              converseId,
            },
            converseId,
          },
        };

        enqueue(sessionId, async () => {
          try {
            await handleInboundMessage({
              account,
              sessionId,
              event: syntheticEvent,
              targetKind: "session",
              log,
              statusSink,
            });
          } catch (err) {
            log?.error?.(`mochat: inbox append(dm) failed for ${sessionId}: ${String(err)}`);
          }
        });
      })().catch((err) => {
        log?.error?.(`mochat: inbox append(dm) handler crashed: ${String(err)}`);
      });
      return;
    }

    if (eventName.startsWith("notify:chat.message.")) {
      if (!payload || typeof payload !== "object") {
        return;
      }
      const groupId = (payload as any).groupId ? String((payload as any).groupId) : "";
      if (!groupId) {
        return;
      }
      const panelId = (payload as any).converseId
        ? String((payload as any).converseId)
        : "";
      if (!panelId) {
        return;
      }
      if (panelSet.size > 0 && !panelSet.has(panelId)) {
        return;
      }

      const event: MochatEvent = {
        seq: 0,
        sessionId: panelId,
        type: "message.add",
        timestamp:
          typeof (payload as any).createdAt === "string"
            ? (payload as any).createdAt
            : new Date().toISOString(),
        payload: {
          messageId: String((payload as any)._id ?? (payload as any).messageId ?? ""),
          author: (payload as any).author ? String((payload as any).author) : "",
          authorInfo: (payload as any).authorInfo ?? undefined,
          content: (payload as any).content,
          meta: (payload as any).meta ?? {},
          groupId,
          converseId: panelId,
        },
      };

      const messageId = resolveMessageId(event);
      if (messageId && rememberMessageId(panelId, messageId)) {
        return;
      }

      enqueue(panelId, async () => {
        try {
          await handleInboundMessage({
            account,
            sessionId: panelId,
            event,
            targetKind: "panel",
            log,
            statusSink,
          });
        } catch (err) {
          log?.error?.(`mochat: panel message failed for ${panelId}: ${String(err)}`);
        }
      });
      return;
    }

    void recordPanelEvent({
      accountId: account.accountId,
      eventName,
      payload,
    }).catch((err) => {
      log?.error?.(`mochat: failed to persist panel event: ${String(err)}`);
    });
  });

  const onAbort = () => {
    stopped = true;
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    socket.disconnect();
    void flushCursorPersist();
  };

  if (abortSignal.aborted) {
    onAbort();
  } else {
    abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  void loadPersistedCursors({ accountId: account.accountId, log })
    .then((persisted) => {
      for (const [sessionId, cursor] of persisted.entries()) {
        cursorBySession.set(sessionId, cursor);
      }
      if (persisted.size > 0) {
        log?.info?.(
          `mochat: restored ${persisted.size} session cursors for ${account.accountId}`,
        );
      }
    })
    .catch((err) => {
      log?.error?.(`mochat: failed loading cursors: ${String(err)}`);
    })
    .finally(() => {
      if (!stopped) {
        socket.connect();
      }
    });

  return {
    stop: () => {
      stopped = true;
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
      socket.disconnect();
      abortSignal.removeEventListener("abort", onAbort);
      void flushCursorPersist();
    },
  };
}
