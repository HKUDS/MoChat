import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { MochatConfig } from "./config-schema.js";

export type MochatAccountConfig = MochatConfig & {
  accounts?: Record<string, MochatConfig | undefined>;
};

export type ResolvedMochatAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  config: Required<
    Pick<
      MochatConfig,
      | "baseUrl"
      | "refreshIntervalMs"
      | "watchTimeoutMs"
      | "watchLimit"
      | "retryDelayMs"
      | "maxRetryAttempts"
      | "socketPath"
      | "socketDisableMsgpack"
      | "socketReconnectDelayMs"
      | "socketMaxReconnectDelayMs"
      | "socketConnectTimeoutMs"
      | "replyDelayMode"
      | "replyDelayMs"
    >
  > &
    Pick<
      MochatConfig,
      | "clawToken"
      | "agentUserId"
      | "sessions"
      | "panels"
      | "mention"
      | "groups"
      | "socketUrl"
    > & {
    autoDiscoverSessions: boolean;
    autoDiscoverPanels: boolean;
  };
};

const DEFAULT_BASE_URL = "http://localhost:11000";
const DEFAULT_WATCH_TIMEOUT_MS = 25000;
const DEFAULT_WATCH_LIMIT = 100;
const DEFAULT_RETRY_DELAY_MS = 200;
const DEFAULT_MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_SOCKET_PATH = "/socket.io";
const DEFAULT_SOCKET_DISABLE_MSGPACK = false;
const DEFAULT_SOCKET_RECONNECT_DELAY_MS = 1000;
const DEFAULT_SOCKET_MAX_RECONNECT_DELAY_MS = 10000;
const DEFAULT_SOCKET_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_REFRESH_INTERVAL_MS = 30000;
const DEFAULT_REPLY_DELAY_MODE = "off";
const DEFAULT_REPLY_DELAY_MS = 120000;

type NormalizedList = {
  items: string[];
  hasWildcard: boolean;
};

function normalizeIdList(values?: string[]): NormalizedList {
  const cleaned = (values ?? [])
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  const hasWildcard = cleaned.includes("*");
  const items = Array.from(new Set(cleaned.filter((entry) => entry !== "*")));
  return { items, hasWildcard };
}

export function listMochatAccountIds(cfg: OpenClawConfig): string[] {
  const channel = (cfg.channels?.mochat ?? {}) as MochatAccountConfig;
  const accountIds = Object.keys(channel.accounts ?? {});
  if (accountIds.length > 0) {
    return accountIds;
  }
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultMochatAccountId(_cfg: OpenClawConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

export function resolveMochatAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedMochatAccount {
  const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const channel = (params.cfg.channels?.mochat ?? {}) as MochatAccountConfig;
  const accountConfig = channel.accounts?.[accountId] ?? channel;

  const baseUrl = accountConfig.baseUrl ?? channel.baseUrl ?? DEFAULT_BASE_URL;
  const clawToken = accountConfig.clawToken ?? channel.clawToken;
  const agentUserId = accountConfig.agentUserId ?? channel.agentUserId;
  const sessionList = normalizeIdList(accountConfig.sessions ?? channel.sessions);
  const panelList = normalizeIdList(accountConfig.panels ?? channel.panels);
  const sessions = sessionList.items;
  const panels = panelList.items;
  const autoDiscoverSessions = sessionList.hasWildcard;
  const autoDiscoverPanels = panelList.hasWildcard;
  const mention = accountConfig.mention ?? channel.mention;
  const groups = accountConfig.groups ?? channel.groups;
  const socketUrl = accountConfig.socketUrl ?? channel.socketUrl ?? baseUrl;
  const socketPath = accountConfig.socketPath ?? channel.socketPath ?? DEFAULT_SOCKET_PATH;
  const socketDisableMsgpack =
    accountConfig.socketDisableMsgpack ??
    channel.socketDisableMsgpack ??
    DEFAULT_SOCKET_DISABLE_MSGPACK;
  const socketReconnectDelayMs =
    accountConfig.socketReconnectDelayMs ??
    channel.socketReconnectDelayMs ??
    DEFAULT_SOCKET_RECONNECT_DELAY_MS;
  const socketMaxReconnectDelayMs =
    accountConfig.socketMaxReconnectDelayMs ??
    channel.socketMaxReconnectDelayMs ??
    DEFAULT_SOCKET_MAX_RECONNECT_DELAY_MS;
  const socketConnectTimeoutMs =
    accountConfig.socketConnectTimeoutMs ??
    channel.socketConnectTimeoutMs ??
    DEFAULT_SOCKET_CONNECT_TIMEOUT_MS;
  const refreshIntervalMs =
    accountConfig.refreshIntervalMs ??
    channel.refreshIntervalMs ??
    DEFAULT_REFRESH_INTERVAL_MS;
  const watchTimeoutMs =
    accountConfig.watchTimeoutMs ?? channel.watchTimeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS;
  const watchLimit = accountConfig.watchLimit ?? channel.watchLimit ?? DEFAULT_WATCH_LIMIT;
  const retryDelayMs =
    accountConfig.retryDelayMs ?? channel.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxRetryAttempts =
    accountConfig.maxRetryAttempts ?? channel.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
  const replyDelayMode =
    accountConfig.replyDelayMode ?? channel.replyDelayMode ?? DEFAULT_REPLY_DELAY_MODE;
  const replyDelayMs =
    accountConfig.replyDelayMs ?? channel.replyDelayMs ?? DEFAULT_REPLY_DELAY_MS;

  const enabled = accountConfig.enabled ?? channel.enabled ?? true;
  const configured =
    Boolean(clawToken?.trim()) &&
    Boolean(agentUserId?.trim()) &&
    ((Array.isArray(sessions) && sessions.length > 0) ||
      (Array.isArray(panels) && panels.length > 0) ||
      autoDiscoverSessions ||
      autoDiscoverPanels);

  return {
    accountId,
    name: accountConfig.name ?? channel.name,
    enabled,
    configured,
    config: {
      baseUrl,
      clawToken,
      agentUserId,
      sessions,
      panels,
      autoDiscoverSessions,
      autoDiscoverPanels,
      mention,
      groups,
      socketUrl,
      socketPath,
      socketDisableMsgpack,
      socketReconnectDelayMs,
      socketMaxReconnectDelayMs,
      socketConnectTimeoutMs,
      refreshIntervalMs,
      watchTimeoutMs,
      watchLimit,
      retryDelayMs,
      maxRetryAttempts,
      replyDelayMode,
      replyDelayMs,
    },
  };
}
