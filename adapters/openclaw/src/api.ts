export type MochatAuthorInfo = {
  userId?: string;
  agentId?: string | null;
  nickname?: string | null;
  email?: string | null;
  avatar?: string | null;
  type?: string;
};

export type MochatEvent = {
  seq: number;
  sessionId: string;
  type: string;
  timestamp?: string;
  payload?: {
    messageId?: string;
    author?: string;
    authorInfo?: MochatAuthorInfo | null;
    content?: unknown;
    meta?: Record<string, unknown>;
    groupId?: string;
    converseId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type MochatParticipantInput = {
  type: "agent" | "user";
  id?: string;
  uniqueName?: string;
  name?: string;
  avatar?: string;
  metadata?: Record<string, unknown>;
};

export type MochatWatchResponse = {
  sessionId: string;
  cursor: number;
  events: MochatEvent[];
};

export type MochatSendResponse = {
  sessionId: string;
  status?: string;
  [key: string]: unknown;
};

export type MochatCreateSessionResponse = {
  sessionId: string;
  workspaceId: string;
  converseId: string;
  participants: string[];
  visibility: string;
  status: string;
  [key: string]: unknown;
};

export type MochatSessionResponse = {
  sessionId: string;
  workspaceId?: string;
  converseId?: string;
  participants?: string[];
  visibility?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

export type MochatMessagesResponse = {
  sessionId: string;
  messages?: unknown[];
  [key: string]: unknown;
};

export type MochatSessionListResponse = {
  sessions?: MochatSessionResponse[];
  [key: string]: unknown;
};

export type MochatGroupResponse = {
  _id?: string;
  id?: string;
  panels?: Array<{
    id?: string;
    _id?: string;
    name?: string;
    type?: number;
    provider?: string;
    pluginPanelName?: string;
    meta?: Record<string, unknown>;
  }>;
  [key: string]: unknown;
};

export type MochatPanelMessagesResponse = {
  groupId?: string;
  panelId: string;
  messages?: unknown[];
  [key: string]: unknown;
};

type MochatRequestOptions = {
  baseUrl: string;
  clawToken: string;
  signal?: AbortSignal;
};

type ClawWrapped<T> = {
  code?: number;
  data?: T;
  name?: string;
  message?: string;
};

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
};

function resolveClawUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.trim();
  const normalizedBase = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  return new URL(path.startsWith("/") ? path : `/${path}`, normalizedBase).toString();
}

async function postJson<T>(
  opts: MochatRequestOptions,
  path: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const url = resolveClawUrl(opts.baseUrl, path);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...DEFAULT_HEADERS,
      "X-Claw-Token": opts.clawToken,
    },
    body: JSON.stringify(payload),
    signal: opts.signal,
  });

  const rawText = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`Claw IM request failed (${response.status}): ${rawText || response.statusText}`);
  }

  let parsed: unknown = rawText;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText) as unknown;
    } catch {
      parsed = rawText;
    }
  }

  if (parsed && typeof parsed === "object") {
    const wrapped = parsed as ClawWrapped<T>;
    if (typeof wrapped.code === "number") {
      if (wrapped.code !== 200) {
        const errMessage = wrapped.message || wrapped.name || "Claw IM request failed";
        throw new Error(`${errMessage} (code=${wrapped.code})`);
      }
      return (wrapped.data ?? ({} as T)) as T;
    }
  }

  return parsed as T;
}

export async function watchSession(params: {
  baseUrl: string;
  clawToken: string;
  sessionId: string;
  cursor: number;
  timeoutMs: number;
  limit: number;
  signal?: AbortSignal;
}): Promise<MochatWatchResponse> {
  return await postJson<MochatWatchResponse>(
    {
      baseUrl: params.baseUrl,
      clawToken: params.clawToken,
      signal: params.signal,
    },
    "/api/claw/sessions/watch",
    {
      sessionId: params.sessionId,
      cursor: params.cursor,
      timeoutMs: params.timeoutMs,
      limit: params.limit,
    },
  );
}

export async function sendSessionMessage(params: {
  baseUrl: string;
  clawToken: string;
  sessionId: string;
  content: string;
  replyTo?: string | null;
  signal?: AbortSignal;
}): Promise<MochatSendResponse> {
  return await postJson<MochatSendResponse>(
    {
      baseUrl: params.baseUrl,
      clawToken: params.clawToken,
      signal: params.signal,
    },
    "/api/claw/sessions/send",
    {
      sessionId: params.sessionId,
      content: params.content,
      ...(params.replyTo ? { replyTo: params.replyTo } : {}),
    },
  );
}

export async function sendPanelMessage(params: {
  baseUrl: string;
  clawToken: string;
  panelId: string;
  content: string;
  replyTo?: string | null;
  signal?: AbortSignal;
  groupId?: string;
}): Promise<MochatSendResponse> {
  return await postJson<MochatSendResponse>(
    {
      baseUrl: params.baseUrl,
      clawToken: params.clawToken,
      signal: params.signal,
    },
    "/api/claw/groups/panels/send",
    {
      panelId: params.panelId,
      content: params.content,
      ...(params.replyTo ? { replyTo: params.replyTo } : {}),
      ...(params.groupId ? { groupId: params.groupId } : {}),
    },
  );
}

export async function createSession(params: {
  baseUrl: string;
  clawToken: string;
  participants: MochatParticipantInput[];
  visibility?: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<MochatCreateSessionResponse> {
  return await postJson<MochatCreateSessionResponse>(
    {
      baseUrl: params.baseUrl,
      clawToken: params.clawToken,
      signal: params.signal,
    },
    "/api/claw/sessions/create",
    {
      participants: params.participants,
      ...(params.visibility ? { visibility: params.visibility } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
    },
  );
}

export async function addParticipants(params: {
  baseUrl: string;
  clawToken: string;
  sessionId: string;
  participants: MochatParticipantInput[];
  signal?: AbortSignal;
}): Promise<MochatSessionResponse> {
  return await postJson<MochatSessionResponse>(
    {
      baseUrl: params.baseUrl,
      clawToken: params.clawToken,
      signal: params.signal,
    },
    "/api/claw/sessions/addParticipants",
    {
      sessionId: params.sessionId,
      participants: params.participants,
    },
  );
}

export async function removeParticipants(params: {
  baseUrl: string;
  clawToken: string;
  sessionId: string;
  participants: MochatParticipantInput[];
  signal?: AbortSignal;
}): Promise<MochatSessionResponse> {
  return await postJson<MochatSessionResponse>(
    {
      baseUrl: params.baseUrl,
      clawToken: params.clawToken,
      signal: params.signal,
    },
    "/api/claw/sessions/removeParticipants",
    {
      sessionId: params.sessionId,
      participants: params.participants,
    },
  );
}

export async function closeSession(params: {
  baseUrl: string;
  clawToken: string;
  sessionId: string;
  policy?: string;
  signal?: AbortSignal;
}): Promise<MochatSessionResponse> {
  return await postJson<MochatSessionResponse>(
    {
      baseUrl: params.baseUrl,
      clawToken: params.clawToken,
      signal: params.signal,
    },
    "/api/claw/sessions/close",
    {
      sessionId: params.sessionId,
      ...(params.policy ? { policy: params.policy } : {}),
    },
  );
}

export async function getSession(params: {
  baseUrl: string;
  clawToken: string;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<MochatSessionResponse> {
  return await postJson<MochatSessionResponse>(
    {
      baseUrl: params.baseUrl,
      clawToken: params.clawToken,
      signal: params.signal,
    },
    "/api/claw/sessions/get",
    {
      sessionId: params.sessionId,
    },
  );
}

export async function getSessionDetail(params: {
  baseUrl: string;
  clawToken: string;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<MochatSessionResponse> {
  return await postJson<MochatSessionResponse>(
    {
      baseUrl: params.baseUrl,
      clawToken: params.clawToken,
      signal: params.signal,
    },
    "/api/claw/sessions/detail",
    {
      sessionId: params.sessionId,
    },
  );
}

export async function listSessionMessages(params: {
  baseUrl: string;
  clawToken: string;
  sessionId: string;
  beforeMessageId?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<MochatMessagesResponse> {
  return await postJson<MochatMessagesResponse>(
    {
      baseUrl: params.baseUrl,
      clawToken: params.clawToken,
      signal: params.signal,
    },
    "/api/claw/sessions/messages",
    {
      sessionId: params.sessionId,
      ...(params.beforeMessageId ? { beforeMessageId: params.beforeMessageId } : {}),
      ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
    },
  );
}

export async function listSessions(params: {
  baseUrl: string;
  clawToken: string;
  updatedAfter?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<MochatSessionListResponse> {
  return await postJson<MochatSessionListResponse>(
    {
      baseUrl: params.baseUrl,
      clawToken: params.clawToken,
      signal: params.signal,
    },
    "/api/claw/sessions/list",
    {
      ...(params.updatedAfter ? { updatedAfter: params.updatedAfter } : {}),
      ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
    },
  );
}

export async function getWorkspaceGroup(params: {
  baseUrl: string;
  clawToken: string;
  groupId?: string;
  signal?: AbortSignal;
}): Promise<MochatGroupResponse> {
  return await postJson<MochatGroupResponse>(
    {
      baseUrl: params.baseUrl,
      clawToken: params.clawToken,
      signal: params.signal,
    },
    "/api/claw/groups/get",
    {
      ...(params.groupId ? { groupId: params.groupId } : {}),
    },
  );
}

export async function listPanelMessages(params: {
  baseUrl: string;
  clawToken: string;
  panelId: string;
  groupId?: string;
  beforeMessageId?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<MochatPanelMessagesResponse> {
  return await postJson<MochatPanelMessagesResponse>(
    {
      baseUrl: params.baseUrl,
      clawToken: params.clawToken,
      signal: params.signal,
    },
    "/api/claw/groups/panels/messages",
    {
      panelId: params.panelId,
      ...(params.groupId ? { groupId: params.groupId } : {}),
      ...(params.beforeMessageId ? { beforeMessageId: params.beforeMessageId } : {}),
      ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
    },
  );
}
