import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  type ChannelOutboundContext,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { MochatConfigSchema } from "./config-schema.js";
import {
  listMochatAccountIds,
  resolveDefaultMochatAccountId,
  resolveMochatAccount,
  type ResolvedMochatAccount,
} from "./accounts.js";
import { sendPanelMessage, sendSessionMessage } from "./api.js";
import { startMochatSocketClient } from "./socket.js";

const meta = {
  id: "mochat",
  label: "Mochat",
  selectionLabel: "Mochat (Claw IM)",
  docsPath: "/channels/mochat",
  docsLabel: "mochat",
  blurb: "Claw IM gateway for MoChat",
  order: 95,
};

function resolveMochatTarget(raw: string): { id: string; isPanel: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { id: "", isPanel: false };
  }
  const lower = trimmed.toLowerCase();
  let id = trimmed;
  let forcePanel = false;
  const prefixes = ["mochat:", "group:", "channel:", "panel:"];
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) {
      id = trimmed.slice(prefix.length).trim();
      if (prefix !== "mochat:") {
        forcePanel = true;
      }
      break;
    }
  }
  const isSessionId = id.startsWith("session_");
  return { id, isPanel: forcePanel || !isSessionId };
}

function buildOutboundContent(ctx: ChannelOutboundContext, mediaUrls?: string[]): string {
  const contentParts: string[] = [];
  if (ctx.text?.trim()) {
    contentParts.push(ctx.text.trim());
  }
  if (mediaUrls && mediaUrls.length > 0) {
    contentParts.push(...mediaUrls);
  }
  return contentParts.join("\n").trim();
}

export const mochatPlugin: ChannelPlugin<ResolvedMochatAccount> = {
  id: "mochat",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
  },
  reload: { configPrefixes: ["channels.mochat"] },
  configSchema: buildChannelConfigSchema(MochatConfigSchema),
  config: {
    listAccountIds: (cfg) => listMochatAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveMochatAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultMochatAccountId(cfg),
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.config.baseUrl,
      sessions: account.config.sessions ?? [],
      panels: account.config.panels ?? [],
      autoDiscoverSessions: account.config.autoDiscoverSessions,
      autoDiscoverPanels: account.config.autoDiscoverPanels,
      agentUserId: account.config.agentUserId ? "[set]" : "[missing]",
      clawToken: account.config.clawToken ? "[set]" : "[missing]",
    }),
  },
  messaging: {
    normalizeTarget: (target) => resolveMochatTarget(target).id || target.trim(),
    targetResolver: {
      looksLikeId: (input) => Boolean(input.trim()),
      hint: "<sessionId>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async (ctx) => {
      const account = resolveMochatAccount({
        cfg: ctx.cfg as OpenClawConfig,
        accountId: ctx.accountId ?? DEFAULT_ACCOUNT_ID,
      });
      if (!account.config.clawToken) {
        throw new Error("Mochat clawToken is not configured");
      }
      const content = buildOutboundContent(ctx, []);
      if (!content) {
        return { channel: "mochat", to: ctx.to };
      }
      const target = resolveMochatTarget(ctx.to);
      if (!target.id) {
        return { channel: "mochat", to: ctx.to };
      }
      const isPanel =
        target.isPanel || (account.config.panels ?? []).includes(target.id);
      if (isPanel) {
        await sendPanelMessage({
          baseUrl: account.config.baseUrl,
          clawToken: account.config.clawToken,
          panelId: target.id,
          content,
          replyTo: ctx.replyToId ?? null,
        });
      } else {
        await sendSessionMessage({
          baseUrl: account.config.baseUrl,
          clawToken: account.config.clawToken,
          sessionId: target.id,
          content,
          replyTo: ctx.replyToId ?? null,
        });
      }
      return { channel: "mochat", to: ctx.to };
    },
    sendMedia: async (ctx) => {
      const account = resolveMochatAccount({
        cfg: ctx.cfg as OpenClawConfig,
        accountId: ctx.accountId ?? DEFAULT_ACCOUNT_ID,
      });
      if (!account.config.clawToken) {
        throw new Error("Mochat clawToken is not configured");
      }
      const mediaUrls = ctx.mediaUrl ? [ctx.mediaUrl] : [];
      const content = buildOutboundContent(ctx, mediaUrls);
      if (!content) {
        return { channel: "mochat", to: ctx.to };
      }
      const target = resolveMochatTarget(ctx.to);
      if (!target.id) {
        return { channel: "mochat", to: ctx.to };
      }
      const isPanel =
        target.isPanel || (account.config.panels ?? []).includes(target.id);
      if (isPanel) {
        await sendPanelMessage({
          baseUrl: account.config.baseUrl,
          clawToken: account.config.clawToken,
          panelId: target.id,
          content,
          replyTo: ctx.replyToId ?? null,
        });
      } else {
        await sendSessionMessage({
          baseUrl: account.config.baseUrl,
          clawToken: account.config.clawToken,
          sessionId: target.id,
          content,
          replyTo: ctx.replyToId ?? null,
        });
      }
      return { channel: "mochat", to: ctx.to };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.config.baseUrl,
      sessions: account.config.sessions ?? [],
      panels: account.config.panels ?? [],
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.configured) {
        throw new Error(
          `Mochat not configured for account "${account.accountId}" (missing clawToken, agentUserId, or sessions)`,
        );
      }

      const sessions = account.config.sessions ?? [];
      const panels = account.config.panels ?? [];
      if (
        sessions.length === 0 &&
        panels.length === 0 &&
        !account.config.autoDiscoverSessions &&
        !account.config.autoDiscoverPanels
      ) {
        throw new Error(
          `Mochat account "${account.accountId}" has no sessions or panels configured`,
        );
      }

      ctx.log?.info(
        `[${account.accountId}] starting Mochat socket (${sessions.length} sessions, ${panels.length} panels)`,
      );

      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });

      const socketClient = startMochatSocketClient({
        account,
        log: ctx.log,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });

      return {
        stop: () => {
          socketClient.stop();
          ctx.setStatus({
            accountId: account.accountId,
            running: false,
            lastStopAt: Date.now(),
          });
        },
      };
    },
  },
};
