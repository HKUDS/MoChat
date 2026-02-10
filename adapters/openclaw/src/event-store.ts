import fs from "node:fs/promises";
import path from "node:path";
import { getMochatRuntime } from "./runtime.js";

type PanelEventRecord = {
  ts: string;
  accountId: string;
  eventName: string;
  payload: unknown;
};

const queues = new Map<string, Promise<void>>();

function resolveEventFilePath(timestamp: Date): string {
  const runtime = getMochatRuntime();
  const stateDir = runtime.state.resolveStateDir();
  const dateKey = timestamp.toISOString().slice(0, 10);
  return path.join(stateDir, "mochat", "events", `${dateKey}.jsonl`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, val) => (typeof val === "bigint" ? val.toString() : val));
  } catch {
    return JSON.stringify({ value: String(value), note: "non-serializable" });
  }
}

async function appendLine(filePath: string, line: string) {
  const previous = queues.get(filePath) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, line, "utf8");
    })
    .catch(() => undefined);
  queues.set(filePath, next);
  await next;
}

export async function recordPanelEvent(params: {
  accountId: string;
  eventName: string;
  payload: unknown;
}) {
  const timestamp = new Date();
  const filePath = resolveEventFilePath(timestamp);
  const record: PanelEventRecord = {
    ts: timestamp.toISOString(),
    accountId: params.accountId,
    eventName: params.eventName,
    payload: params.payload,
  };
  const line = `${safeStringify(record)}\n`;
  await appendLine(filePath, line);
}
