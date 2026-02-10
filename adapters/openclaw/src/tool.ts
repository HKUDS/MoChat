import { Type } from "@sinclair/typebox";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import {
  addParticipants,
  closeSession,
  createSession,
  getSession,
  getSessionDetail,
  listSessionMessages,
  removeParticipants,
  sendSessionMessage,
  watchSession,
  type MochatParticipantInput,
} from "./api.js";
import { resolveMochatAccount } from "./accounts.js";
import { getMochatRuntime } from "./runtime.js";

const ACTIONS = [
  "create",
  "send",
  "addParticipants",
  "removeParticipants",
  "watch",
  "get",
  "detail",
  "messages",
  "close",
] as const;

type MochatAction = (typeof ACTIONS)[number];

function stringEnum<T extends readonly string[]>(values: T, options: { description?: string } = {}) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}

const MochatParticipantSchema = Type.Object(
  {
    type: stringEnum(["agent", "user"], { description: "Participant type" }),
    id: Type.Optional(Type.String({ description: "User or agent id" })),
    uniqueName: Type.Optional(Type.String({ description: "User uniqueName" })),
    name: Type.Optional(Type.String({ description: "Display name" })),
    avatar: Type.Optional(Type.String({ description: "Avatar URL" })),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const MochatToolSchema = Type.Object(
  {
    action: stringEnum(ACTIONS, { description: `Action to perform: ${ACTIONS.join(", ")}` }),
    accountId: Type.Optional(Type.String({ description: "Account id (optional)" })),
    sessionId: Type.Optional(Type.String({ description: "Session ID" })),
    content: Type.Optional(Type.String({ description: "Message content" })),
    replyTo: Type.Optional(Type.String({ description: "Reply-to message id" })),
    participants: Type.Optional(Type.Array(MochatParticipantSchema)),
    visibility: Type.Optional(Type.String({ description: "Session visibility" })),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    cursor: Type.Optional(Type.Number({ description: "Watch cursor" })),
    timeoutMs: Type.Optional(Type.Number({ description: "Watch timeout (ms)" })),
    limit: Type.Optional(Type.Number({ description: "Watch/message limit" })),
    beforeMessageId: Type.Optional(Type.String({ description: "Messages before id" })),
    policy: Type.Optional(Type.String({ description: "Close policy" })),
  },
  { additionalProperties: false },
);

function readParticipants(params: Record<string, unknown>): MochatParticipantInput[] {
  const raw = params.participants;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("participants required");
  }
  return raw as MochatParticipantInput[];
}

function resolveAccount(params: Record<string, unknown>) {
  const accountId = readStringParam(params, "accountId", { required: false });
  const runtime = getMochatRuntime();
  const cfg = runtime.config.loadConfig();
  const account = resolveMochatAccount({ cfg, accountId });
  if (!account.config.clawToken) {
    throw new Error("Mochat clawToken is not configured");
  }
  return account;
}

export const mochatTool: AnyAgentTool = {
  name: "mochat_session",
  description: "Manage Mochat (Claw IM) sessions via the Claw IM API",
  parameters: MochatToolSchema,
  async execute(_toolCallId, params) {
    try {
      const action = readStringParam(params as Record<string, unknown>, "action", {
        required: true,
        label: "action",
      }) as MochatAction;

      const account = resolveAccount(params as Record<string, unknown>);
      const baseUrl = account.config.baseUrl;
      const clawToken = account.config.clawToken ?? "";

      switch (action) {
        case "create": {
          const participants = readParticipants(params as Record<string, unknown>);
          const visibility = readStringParam(params as Record<string, unknown>, "visibility");
          const metadata = params.metadata as Record<string, unknown> | undefined;
          const result = await createSession({
            baseUrl,
            clawToken,
            participants,
            visibility: visibility || undefined,
            metadata,
          });
          return jsonResult(result);
        }
        case "send": {
          const sessionId = readStringParam(params as Record<string, unknown>, "sessionId", {
            required: true,
            label: "sessionId",
          });
          const content = readStringParam(params as Record<string, unknown>, "content", {
            required: true,
            label: "content",
          });
          const replyTo = readStringParam(params as Record<string, unknown>, "replyTo");
          const result = await sendSessionMessage({
            baseUrl,
            clawToken,
            sessionId,
            content,
            replyTo,
          });
          return jsonResult(result);
        }
        case "addParticipants": {
          const sessionId = readStringParam(params as Record<string, unknown>, "sessionId", {
            required: true,
            label: "sessionId",
          });
          const participants = readParticipants(params as Record<string, unknown>);
          const result = await addParticipants({
            baseUrl,
            clawToken,
            sessionId,
            participants,
          });
          return jsonResult(result);
        }
        case "removeParticipants": {
          const sessionId = readStringParam(params as Record<string, unknown>, "sessionId", {
            required: true,
            label: "sessionId",
          });
          const participants = readParticipants(params as Record<string, unknown>);
          const result = await removeParticipants({
            baseUrl,
            clawToken,
            sessionId,
            participants,
          });
          return jsonResult(result);
        }
        case "watch": {
          const sessionId = readStringParam(params as Record<string, unknown>, "sessionId", {
            required: true,
            label: "sessionId",
          });
          const cursor = readNumberParam(params as Record<string, unknown>, "cursor") ?? 0;
          const timeoutMs =
            readNumberParam(params as Record<string, unknown>, "timeoutMs") ??
            account.config.watchTimeoutMs;
          const limit =
            readNumberParam(params as Record<string, unknown>, "limit") ?? account.config.watchLimit;
          const result = await watchSession({
            baseUrl,
            clawToken,
            sessionId,
            cursor,
            timeoutMs,
            limit,
          });
          return jsonResult(result);
        }
        case "get": {
          const sessionId = readStringParam(params as Record<string, unknown>, "sessionId", {
            required: true,
            label: "sessionId",
          });
          const result = await getSession({ baseUrl, clawToken, sessionId });
          return jsonResult(result);
        }
        case "detail": {
          const sessionId = readStringParam(params as Record<string, unknown>, "sessionId", {
            required: true,
            label: "sessionId",
          });
          const result = await getSessionDetail({ baseUrl, clawToken, sessionId });
          return jsonResult(result);
        }
        case "messages": {
          const sessionId = readStringParam(params as Record<string, unknown>, "sessionId", {
            required: true,
            label: "sessionId",
          });
          const beforeMessageId = readStringParam(
            params as Record<string, unknown>,
            "beforeMessageId",
          );
          const limit = readNumberParam(params as Record<string, unknown>, "limit");
          const result = await listSessionMessages({
            baseUrl,
            clawToken,
            sessionId,
            beforeMessageId: beforeMessageId || undefined,
            limit: typeof limit === "number" ? limit : undefined,
          });
          return jsonResult(result);
        }
        case "close": {
          const sessionId = readStringParam(params as Record<string, unknown>, "sessionId", {
            required: true,
            label: "sessionId",
          });
          const policy = readStringParam(params as Record<string, unknown>, "policy");
          const result = await closeSession({
            baseUrl,
            clawToken,
            sessionId,
            policy: policy || undefined,
          });
          return jsonResult(result);
        }
        default: {
          action satisfies never;
          throw new Error(`Unknown action: ${String(action)}`);
        }
      }
    } catch (err) {
      return jsonResult({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
