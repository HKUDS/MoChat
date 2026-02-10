import type { ChannelLogSink, OpenClawConfig } from "openclaw/plugin-sdk";
import { sendPanelMessage, sendSessionMessage, type MochatEvent } from "./api.js";
import type { ResolvedMochatAccount } from "./accounts.js";
import {
  enqueueDelayedEntry,
  flushDelayedEntries,
  type MochatBufferedEntry,
} from "./delay-buffer.js";
import { getMochatRuntime } from "./runtime.js";

export type MochatStatusSink = (patch: {
  lastInboundAt?: number;
  lastOutboundAt?: number;
  lastError?: string | null;
}) => void;

function normalizeContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === null || content === undefined) {
    return "";
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function parseTimestamp(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractMentionIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) {
      ids.push(entry.trim());
      continue;
    }
    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const candidate =
        (typeof obj.id === "string" ? obj.id : undefined) ??
        (typeof obj.userId === "string" ? obj.userId : undefined) ??
        (typeof obj._id === "string" ? obj._id : undefined);
      if (candidate) {
        ids.push(candidate);
      }
    }
  }
  return ids;
}

function resolveWasMentioned(payload: MochatEvent["payload"], agentUserId?: string): boolean {
  const meta = payload?.meta as Record<string, unknown> | undefined;
  if (meta) {
    const directBool =
      (typeof meta.mentioned === "boolean" && meta.mentioned) ||
      (typeof meta.wasMentioned === "boolean" && meta.wasMentioned);
    if (directBool) {
      return true;
    }

    const mentionSources = [
      meta.mentions,
      meta.mentionIds,
      meta.mentionedUserIds,
      meta.mentionedUsers,
    ];
    for (const source of mentionSources) {
      const ids = extractMentionIds(source);
      if (agentUserId && ids.includes(agentUserId)) {
        return true;
      }
    }
  }

  if (!agentUserId) {
    return false;
  }
  const content = typeof payload?.content === "string" ? payload.content : "";
  if (!content) {
    return false;
  }
  return content.includes(`<@${agentUserId}>`) || content.includes(`@${agentUserId}`);
}

function resolveRequireMention(params: {
  account: ResolvedMochatAccount;
  sessionId: string;
  groupId?: string;
}): boolean {
  const { account, sessionId, groupId } = params;
  const groups = account.config.groups;
  if (groups) {
    if (groupId && typeof groups[groupId]?.requireMention === "boolean") {
      return groups[groupId]?.requireMention ?? false;
    }
    const direct = groups[sessionId]?.requireMention;
    if (typeof direct === "boolean") {
      return direct;
    }
    const wildcard = groups["*"]?.requireMention;
    if (typeof wildcard === "boolean") {
      return wildcard;
    }
  }
  return Boolean(account.config.mention?.requireInGroups);
}

function resolveSenderLabel(entry: MochatBufferedEntry): string {
  return (
    (entry.senderName && entry.senderName.trim()) ||
    (entry.senderUsername && entry.senderUsername.trim()) ||
    entry.author
  );
}

function buildBufferedBody(entries: MochatBufferedEntry[], isGroup: boolean): string {
  if (entries.length === 1) {
    return entries[0]?.rawBody ?? "";
  }
  const lines: string[] = [];
  for (const entry of entries) {
    const body = entry.rawBody;
    if (!body) {
      continue;
    }
    if (isGroup) {
      const label = resolveSenderLabel(entry);
      if (label) {
        lines.push(`${label}: ${body}`);
        continue;
      }
    }
    lines.push(body);
  }
  return lines.join("\n").trim();
}

async function dispatchBufferedEntries(params: {
  account: ResolvedMochatAccount;
  sessionId: string;
  targetKind: "session" | "panel";
  entries: MochatBufferedEntry[];
  isGroup: boolean;
  wasMentioned: boolean;
  log?: ChannelLogSink;
  statusSink?: MochatStatusSink;
  markInboundAt?: boolean;
}) {
  const {
    account,
    sessionId,
    targetKind,
    entries,
    isGroup,
    wasMentioned,
    log,
    statusSink,
  } = params;
  if (entries.length === 0) {
    return;
  }
  const rawBody = buildBufferedBody(entries, isGroup);
  const lastEntry = entries[entries.length - 1];

  const core = getMochatRuntime();
  const config = core.config.loadConfig() as OpenClawConfig;

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "mochat",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: sessionId,
    },
  });

  const fromLabel = isGroup
    ? `group:${lastEntry.groupId ?? sessionId}`
    : `user:${lastEntry.author}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Mochat",
    from: fromLabel,
    timestamp: lastEntry.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `mochat:${lastEntry.author}`,
    To: `mochat:${sessionId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: lastEntry.senderName || undefined,
    SenderUsername: lastEntry.senderUsername || undefined,
    SenderId: lastEntry.author,
    WasMentioned: isGroup ? wasMentioned : undefined,
    MessageSid: lastEntry.messageId,
    Timestamp: lastEntry.timestamp,
    GroupSubject: isGroup ? String(lastEntry.groupId ?? sessionId) : undefined,
    Provider: "mochat",
    Surface: "mochat",
    OriginatingChannel: "mochat",
    OriginatingTo: `mochat:${sessionId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      log?.error?.(`mochat: failed updating session meta: ${String(err)}`);
    },
  });

  if (params.markInboundAt !== false) {
    statusSink?.({ lastInboundAt: Date.now(), lastError: null });
  }

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload: {
        text?: string;
        mediaUrls?: string[];
        mediaUrl?: string;
        replyToId?: string | null;
      }) => {
        const contentParts: string[] = [];
        if (payload.text) {
          contentParts.push(payload.text);
        }
        const mediaUrls = [
          ...(payload.mediaUrls ?? []),
          ...(payload.mediaUrl ? [payload.mediaUrl] : []),
        ].filter(Boolean);
        if (mediaUrls.length > 0) {
          contentParts.push(...mediaUrls);
        }
        const content = contentParts.join("\n").trim();
        if (!content) {
          return;
        }
        if (targetKind === "panel") {
          await sendPanelMessage({
            baseUrl: account.config.baseUrl,
            clawToken: account.config.clawToken ?? "",
            panelId: sessionId,
            content,
            replyTo: payload.replyToId ?? null,
          });
        } else {
          await sendSessionMessage({
            baseUrl: account.config.baseUrl,
            clawToken: account.config.clawToken ?? "",
            sessionId,
            content,
            replyTo: payload.replyToId ?? null,
          });
        }
        statusSink?.({ lastOutboundAt: Date.now(), lastError: null });
      },
      onError: (err, info) => {
        log?.error?.(`mochat ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

export async function handleInboundMessage(params: {
  account: ResolvedMochatAccount;
  sessionId: string;
  event: MochatEvent;
  targetKind?: "session" | "panel";
  log?: ChannelLogSink;
  statusSink?: MochatStatusSink;
}) {
  const { account, sessionId, event, log, statusSink } = params;
  const targetKind = params.targetKind ?? "session";
  const payload = event.payload;
  if (!payload) {
    log?.info?.(
      `mochat: inbound dropped target=${targetKind} session=${sessionId} reason=missing-payload`,
    );
    return;
  }
  const author = payload.author ? String(payload.author) : "";
  const authorInfo =
    payload.authorInfo && typeof payload.authorInfo === "object"
      ? (payload.authorInfo as {
          nickname?: string | null;
          email?: string | null;
          agentId?: string | null;
        })
      : null;
  const senderName =
    (authorInfo?.nickname && authorInfo.nickname.trim()) ||
    (authorInfo?.email && authorInfo.email.trim()) ||
    "";
  if (!author) {
    log?.info?.(
      `mochat: inbound dropped target=${targetKind} session=${sessionId} reason=missing-author mid=${String(payload.messageId ?? "")}`,
    );
    return;
  }
  const agentUserId = account.config.agentUserId;
  if (agentUserId && author === agentUserId) {
    log?.info?.(
      `mochat: inbound dropped target=${targetKind} session=${sessionId} reason=self-author mid=${String(payload.messageId ?? "")}`,
    );
    return;
  }

  const isGroup = Boolean(payload.groupId);
  const wasMentioned = resolveWasMentioned(payload, agentUserId);
  const requireMention =
    targetKind === "panel" &&
    isGroup &&
    resolveRequireMention({ account, sessionId, groupId: String(payload.groupId ?? "") });
  const replyDelayMode = account.config.replyDelayMode;
  const useDelay = targetKind === "panel" && replyDelayMode === "non-mention";
  if (requireMention && !wasMentioned && !useDelay) {
    log?.info?.(
      `mochat: inbound dropped target=${targetKind} session=${sessionId} reason=mention-required mid=${String(payload.messageId ?? "")}`,
    );
    return;
  }

  const rawBody = normalizeContent(payload.content);
  const timestamp = parseTimestamp(event.timestamp);
  const entry: MochatBufferedEntry = {
    rawBody,
    author,
    senderName: senderName || undefined,
    senderUsername: authorInfo?.agentId || undefined,
    timestamp,
    messageId: payload.messageId ? String(payload.messageId) : undefined,
    groupId: isGroup ? String(payload.groupId ?? sessionId) : undefined,
  };

  if (useDelay) {
    log?.info?.(
      `mochat: inbound queued target=${targetKind} session=${sessionId} mode=delay mid=${String(payload.messageId ?? "")} mentioned=${String(wasMentioned)}`,
    );
    statusSink?.({ lastInboundAt: Date.now(), lastError: null });
    const delayKey = `${account.accountId}:${targetKind}:${sessionId}`;
    const delayMs = account.config.replyDelayMs;
    const onFlush = async (entries: MochatBufferedEntry[], reason: "mention" | "timer") => {
      await dispatchBufferedEntries({
        account,
        sessionId,
        targetKind,
        entries,
        isGroup,
        wasMentioned: reason === "mention",
        log,
        statusSink,
        markInboundAt: false,
      });
    };

    if (wasMentioned) {
      await flushDelayedEntries({
        key: delayKey,
        entry,
        reason: "mention",
        onFlush,
      });
    } else {
      await enqueueDelayedEntry({
        key: delayKey,
        entry,
        delayMs,
        onFlush,
      });
    }
    return;
  }

  log?.info?.(
    `mochat: inbound dispatch target=${targetKind} session=${sessionId} mid=${String(payload.messageId ?? "")} group=${String(isGroup)} mentioned=${String(wasMentioned)}`,
  );
  await dispatchBufferedEntries({
    account,
    sessionId,
    targetKind,
    entries: [entry],
    isGroup,
    wasMentioned,
    log,
    statusSink,
  });
}
