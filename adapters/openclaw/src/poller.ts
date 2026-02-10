import type { ChannelLogSink } from "openclaw/plugin-sdk";
import { watchSession } from "./api.js";
import type { ResolvedMochatAccount } from "./accounts.js";
import { handleInboundMessage, type MochatStatusSink } from "./inbound.js";

async function sleep(ms: number, signal?: AbortSignal) {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }
  });
}

function computeBackoffMs(params: {
  baseDelayMs: number;
  consecutiveErrors: number;
  maxDelayMs: number;
}) {
  const baseDelayMs = Math.max(1, params.baseDelayMs);
  const maxDelayMs = Math.max(baseDelayMs, params.maxDelayMs);
  const exponent = Math.max(0, params.consecutiveErrors - 1);
  const delayMs = baseDelayMs * Math.pow(2, exponent);
  return Math.min(delayMs, maxDelayMs);
}

export function startMochatSessionPoller(params: {
  account: ResolvedMochatAccount;
  sessionId: string;
  log?: ChannelLogSink;
  abortSignal: AbortSignal;
  statusSink?: MochatStatusSink;
}) {
  const { account, sessionId, log, abortSignal, statusSink } = params;
  const controller = new AbortController();
  let stopped = false;
  let cursor = 0;
  let consecutiveErrors = 0;
  const maxBackoffMs = 30000;

  const onAbort = () => {
    stopped = true;
    controller.abort();
  };
  if (abortSignal.aborted) {
    onAbort();
  } else {
    abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  const run = async () => {
    while (!stopped) {
      try {
        const response = await watchSession({
          baseUrl: account.config.baseUrl,
          clawToken: account.config.clawToken ?? "",
          sessionId,
          cursor,
          timeoutMs: account.config.watchTimeoutMs,
          limit: account.config.watchLimit,
          signal: controller.signal,
        });

        cursor = typeof response.cursor === "number" ? response.cursor : cursor;
        consecutiveErrors = 0;

        for (const event of response.events ?? []) {
          if (event.type !== "message.add") {
            continue;
          }
          await handleInboundMessage({
            account,
            sessionId,
            event,
            log,
            statusSink,
          });
        }
      } catch (err) {
        if (controller.signal.aborted) {
          break;
        }
        const message = err instanceof Error ? err.message : String(err);
        log?.error?.(`mochat: watch failed for ${sessionId}: ${message}`);
        statusSink?.({ lastError: message });
        consecutiveErrors += 1;
        const delayMs = computeBackoffMs({
          baseDelayMs: account.config.retryDelayMs,
          consecutiveErrors,
          maxDelayMs: maxBackoffMs,
        });
        await sleep(delayMs, controller.signal);
      }
    }
  };

  void run();

  return {
    stop: () => {
      stopped = true;
      controller.abort();
      abortSignal.removeEventListener("abort", onAbort);
    },
  };
}
