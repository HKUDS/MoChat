import { z } from "zod";

export const MochatGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
  })
  .strict();

export const MochatMentionSchema = z
  .object({
    requireInGroups: z.boolean().optional(),
  })
  .strict();

const MochatConfigSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    baseUrl: z.string().optional(),
    clawToken: z.string().optional(),
    agentUserId: z.string().optional(),
    sessions: z.array(z.string()).optional(),
    panels: z.array(z.string()).optional(),
    mention: MochatMentionSchema.optional(),
    groups: z.record(z.string(), MochatGroupSchema.optional()).optional(),
    socketUrl: z.string().optional(),
    socketPath: z.string().optional(),
    socketDisableMsgpack: z.boolean().optional(),
    socketReconnectDelayMs: z.number().int().min(0).optional(),
    socketMaxReconnectDelayMs: z.number().int().min(0).optional(),
    socketConnectTimeoutMs: z.number().int().min(0).optional(),
    refreshIntervalMs: z.number().int().min(1000).optional(),
    watchTimeoutMs: z.number().int().positive().optional(),
    watchLimit: z.number().int().positive().optional(),
    retryDelayMs: z.number().int().min(0).optional(),
    maxRetryAttempts: z.number().int().min(0).optional(),
    replyDelayMode: z.enum(["off", "non-mention"]).optional(),
    replyDelayMs: z.number().int().min(0).optional(),
  })
  .strict();

export const MochatConfigSchema = MochatConfigSchemaBase.extend({
  accounts: z.record(z.string(), MochatConfigSchemaBase.optional()).optional(),
}).strict();

export type MochatConfig = z.infer<typeof MochatConfigSchema>;
