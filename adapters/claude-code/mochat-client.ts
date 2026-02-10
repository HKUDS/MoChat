#!/usr/bin/env node
/**
 * Mochat Client for ClaudeClaw
 * - Receives Mochat events via Socket.IO and writes them to incoming queue
 * - Reads outgoing queue responses and sends them back to Mochat
 */
export {};

const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');
const msgpackParser = require('socket.io-msgpack-parser');
const dotenv = require('dotenv');

const SCRIPT_DIR = __dirname;
const QUEUE_INCOMING = path.join(SCRIPT_DIR, '.claudeclaw/queue/incoming');
const QUEUE_OUTGOING = path.join(SCRIPT_DIR, '.claudeclaw/queue/outgoing');
const LOG_FILE = path.join(SCRIPT_DIR, '.claudeclaw/logs/mochat.log');
const STATE_DIR = path.join(SCRIPT_DIR, '.claudeclaw/state/mochat');
const CURSOR_STORE_FILE = path.join(STATE_DIR, 'cursors_default.json');

[QUEUE_INCOMING, QUEUE_OUTGOING, path.dirname(LOG_FILE), STATE_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

dotenv.config({ path: path.join(SCRIPT_DIR, '.env'), quiet: true });

function log(level, message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    fs.appendFileSync(LOG_FILE, logMessage);
}

function parseBool(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    const normalized = String(value).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function parseIntValue(value, defaultValue) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseJsonArray(value, defaultValue = []) {
    if (value === undefined || value === null || String(value).trim() === '') {
        return defaultValue;
    }

    const raw = String(value).trim();
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed.map((item) => String(item).trim()).filter(Boolean);
        }
    } catch (_) {
        // Fall back to CSV parsing below.
    }

    return raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function parseJsonObject(value, defaultValue = {}) {
    if (value === undefined || value === null || String(value).trim() === '') {
        return defaultValue;
    }

    try {
        const parsed = JSON.parse(String(value));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    } catch (_) {
        // Ignore parse errors and keep defaults.
    }

    return defaultValue;
}

function normalizeIdList(values) {
    const cleaned = (values || [])
        .map((entry) => String(entry).trim())
        .filter(Boolean);
    const hasWildcard = cleaned.includes('*');
    const items = Array.from(new Set(cleaned.filter((entry) => entry !== '*')));
    return { items, hasWildcard };
}

const rawSessions = parseJsonArray(process.env.MOCHAT_SESSIONS, ['*']);
const rawPanels = parseJsonArray(process.env.MOCHAT_PANELS, ['*']);
const sessionList = normalizeIdList(rawSessions);
const panelList = normalizeIdList(rawPanels);

const config = {
    enabled: parseBool(process.env.MOCHAT_ENABLED, false),
    baseUrl: (process.env.MOCHAT_BASE_URL || 'http://localhost:11000').trim(),
    socketUrl: (process.env.MOCHAT_SOCKET_URL || process.env.MOCHAT_BASE_URL || 'http://localhost:11000').trim(),
    socketPath: (process.env.MOCHAT_SOCKET_PATH || '/socket.io').trim(),
    socketDisableMsgpack: parseBool(process.env.MOCHAT_SOCKET_DISABLE_MSGPACK, false),
    socketReconnectDelayMs: parseIntValue(process.env.MOCHAT_SOCKET_RECONNECT_DELAY_MS, 1000),
    socketMaxReconnectDelayMs: parseIntValue(process.env.MOCHAT_SOCKET_MAX_RECONNECT_DELAY_MS, 10000),
    socketConnectTimeoutMs: parseIntValue(process.env.MOCHAT_SOCKET_CONNECT_TIMEOUT_MS, 10000),
    refreshIntervalMs: Math.max(parseIntValue(process.env.MOCHAT_REFRESH_INTERVAL_MS, 30000), 1000),
    watchLimit: Math.max(parseIntValue(process.env.MOCHAT_WATCH_LIMIT, 100), 1),
    maxRetryAttempts: Math.max(parseIntValue(process.env.MOCHAT_MAX_RETRY_ATTEMPTS, 3), 0),
    clawToken: (process.env.MOCHAT_CLAW_TOKEN || '').trim(),
    agentUserId: (process.env.MOCHAT_AGENT_USER_ID || '').trim(),
    sessions: sessionList.items,
    panels: panelList.items,
    autoDiscoverSessions: sessionList.hasWildcard,
    autoDiscoverPanels: panelList.hasWildcard,
    replyDelayMode: (process.env.MOCHAT_REPLY_DELAY_MODE || 'non-mention').trim(),
    replyDelayMs: Math.max(parseIntValue(process.env.MOCHAT_REPLY_DELAY_MS, 120000), 0),
    requireMentionInGroups: parseBool(process.env.MOCHAT_REQUIRE_MENTION_IN_GROUPS, false),
    groupRules: parseJsonObject(process.env.MOCHAT_GROUP_RULES, {}),
    workspaceGroupId: (process.env.MOCHAT_WORKSPACE_GROUP_ID || '').trim(),
};

function resolveMochatUrl(baseUrl, endpointPath) {
    const trimmed = baseUrl.trim();
    const normalizedBase = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
    return new URL(endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`, normalizedBase).toString();
}

async function postJson(endpointPath, payload) {
    const url = resolveMochatUrl(config.baseUrl, endpointPath);
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Claw-Token': config.clawToken,
        },
        body: JSON.stringify(payload),
    });

    const text = await response.text().catch(() => '');
    if (!response.ok) {
        throw new Error(`Mochat API error (${response.status}): ${text || response.statusText}`);
    }

    let parsed: any = text;
    if (text) {
        try {
            parsed = JSON.parse(text);
        } catch (_) {
            parsed = text;
        }
    }

    if (parsed && typeof parsed === 'object' && typeof parsed.code === 'number') {
        if (parsed.code !== 200) {
            const errMessage = parsed.message || parsed.name || 'Mochat request failed';
            throw new Error(`${errMessage} (code=${parsed.code})`);
        }
        return parsed.data || {};
    }

    return parsed;
}

async function sendSessionMessage(params) {
    return postJson('/api/claw/sessions/send', {
        sessionId: params.sessionId,
        content: params.content,
        ...(params.replyTo ? { replyTo: params.replyTo } : {}),
    });
}

async function sendPanelMessage(params) {
    return postJson('/api/claw/groups/panels/send', {
        panelId: params.panelId,
        content: params.content,
        ...(params.replyTo ? { replyTo: params.replyTo } : {}),
        ...(params.groupId ? { groupId: params.groupId } : {}),
    });
}

async function listSessions() {
    return postJson('/api/claw/sessions/list', {});
}

async function getWorkspaceGroup() {
    return postJson('/api/claw/groups/get', {
        ...(config.workspaceGroupId ? { groupId: config.workspaceGroupId } : {}),
    });
}

const pendingMessages = new Map(); // queueMessageId -> routing info

const delayBuffers = new Map();
function getDelayState(key) {
    if (!delayBuffers.has(key)) {
        delayBuffers.set(key, {
            entries: [],
            timer: null,
            queue: Promise.resolve(),
            onFlush: null,
        });
    }
    return delayBuffers.get(key);
}

function enqueueDelayTask(key, task) {
    const state = getDelayState(key);
    const next = state.queue.then(task, task);
    state.queue = next.catch(() => undefined);
    return next;
}

function clearDelayTimer(state) {
    if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
    }
}

async function flushDelayInternal(key, reason, onFlush = undefined) {
    const state = delayBuffers.get(key);
    if (!state) {
        return;
    }

    clearDelayTimer(state);
    if (onFlush) {
        state.onFlush = onFlush;
    }

    const entries = state.entries.slice();
    state.entries.length = 0;

    if (!entries.length || !state.onFlush) {
        return;
    }

    await state.onFlush(entries, reason);
}

async function enqueueDelayedEntry(params) {
    const { key, entry, delayMs, onFlush } = params;
    await enqueueDelayTask(key, async () => {
        const state = getDelayState(key);
        state.onFlush = onFlush;
        state.entries.push(entry);
        clearDelayTimer(state);
        state.timer = setTimeout(() => {
            void enqueueDelayTask(key, () => flushDelayInternal(key, 'timer'));
        }, Math.max(0, delayMs));
    });
}

async function flushDelayedEntries(params) {
    const { key, entry, reason, onFlush } = params;
    await enqueueDelayTask(key, async () => {
        const state = getDelayState(key);
        state.onFlush = onFlush;
        if (entry) {
            state.entries.push(entry);
        }
        await flushDelayInternal(key, reason, onFlush);
    });
}

function normalizeContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (content === null || content === undefined) {
        return '';
    }
    try {
        return JSON.stringify(content);
    } catch (_) {
        return String(content);
    }
}

function parseTimestamp(value) {
    if (!value) {
        return undefined;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function extractMentionIds(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    const ids = [];
    for (const entry of value) {
        if (typeof entry === 'string' && entry.trim()) {
            ids.push(entry.trim());
            continue;
        }
        if (entry && typeof entry === 'object') {
            const candidate =
                (typeof entry.id === 'string' ? entry.id : undefined) ||
                (typeof entry.userId === 'string' ? entry.userId : undefined) ||
                (typeof entry._id === 'string' ? entry._id : undefined);
            if (candidate) {
                ids.push(candidate);
            }
        }
    }

    return ids;
}

function resolveWasMentioned(payload) {
    const meta = payload && typeof payload.meta === 'object' ? payload.meta : undefined;

    if (meta) {
        const directMention =
            (typeof meta.mentioned === 'boolean' && meta.mentioned) ||
            (typeof meta.wasMentioned === 'boolean' && meta.wasMentioned);
        if (directMention) {
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
            if (config.agentUserId && ids.includes(config.agentUserId)) {
                return true;
            }
        }
    }

    if (!config.agentUserId) {
        return false;
    }

    const text = typeof payload.content === 'string' ? payload.content : '';
    if (!text) {
        return false;
    }

    return text.includes(`<@${config.agentUserId}>`) || text.includes(`@${config.agentUserId}`);
}

function resolveRequireMention(sessionId, groupId) {
    const rules = config.groupRules;
    if (rules && typeof rules === 'object') {
        if (groupId && rules[groupId] && typeof rules[groupId].requireMention === 'boolean') {
            return rules[groupId].requireMention;
        }
        if (rules[sessionId] && typeof rules[sessionId].requireMention === 'boolean') {
            return rules[sessionId].requireMention;
        }
        if (rules['*'] && typeof rules['*'].requireMention === 'boolean') {
            return rules['*'].requireMention;
        }
    }
    return config.requireMentionInGroups;
}

function resolveSenderLabel(entry) {
    return (entry.senderName && entry.senderName.trim()) ||
        (entry.senderUsername && entry.senderUsername.trim()) ||
        entry.author;
}

function buildBufferedBody(entries, isGroup) {
    if (entries.length === 1) {
        return entries[0].rawBody || '';
    }

    const lines = [];
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

    return lines.join('\n').trim();
}

function cleanupPendingMessages() {
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    for (const [id, state] of pendingMessages.entries()) {
        if (state.timestamp < tenMinutesAgo) {
            pendingMessages.delete(id);
        }
    }
}

async function dispatchBufferedEntries(params) {
    const {
        targetKind,
        targetId,
        entries,
        isGroup,
        wasMentioned,
    } = params;

    if (!entries.length) {
        return;
    }

    const body = buildBufferedBody(entries, isGroup).trim();
    if (!body) {
        return;
    }

    const lastEntry = entries[entries.length - 1];
    const sender = resolveSenderLabel(lastEntry) || lastEntry.author || targetId;

    const queueMessageId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const queueData = {
        channel: 'mochat',
        sender,
        senderId: lastEntry.author || targetId,
        message: body,
        timestamp: Date.now(),
        messageId: queueMessageId,
        metadata: {
            targetKind,
            targetId,
            groupId: lastEntry.groupId || null,
            sourceMessageId: lastEntry.messageId || null,
            wasMentioned,
            bufferedCount: entries.length,
        },
    };

    const queueFile = path.join(QUEUE_INCOMING, `mochat_${queueMessageId}.json`);
    fs.writeFileSync(queueFile, JSON.stringify(queueData, null, 2));

    pendingMessages.set(queueMessageId, {
        targetKind,
        targetId,
        groupId: lastEntry.groupId || null,
        replyTo: lastEntry.messageId || null,
        timestamp: Date.now(),
    });

    cleanupPendingMessages();
    log('INFO', `✓ Queued Mochat message ${queueMessageId} (${targetKind}:${targetId}, ${entries.length} part)`);
}

async function handleInboundMessage(params) {
    const {
        targetKind,
        sessionId,
        event,
    } = params;

    if (!event || typeof event !== 'object' || !event.payload) {
        return;
    }

    const payload = event.payload;
    const author = payload.author ? String(payload.author).trim() : '';
    if (!author) {
        return;
    }

    if (config.agentUserId && author === config.agentUserId) {
        return;
    }

    const authorInfo = payload.authorInfo && typeof payload.authorInfo === 'object'
        ? payload.authorInfo
        : null;

    const senderName = (
        (authorInfo && typeof authorInfo.nickname === 'string' && authorInfo.nickname.trim()) ||
        (authorInfo && typeof authorInfo.email === 'string' && authorInfo.email.trim()) ||
        ''
    );

    const senderUsername = (
        authorInfo && typeof authorInfo.agentId === 'string' && authorInfo.agentId.trim()
            ? authorInfo.agentId.trim()
            : undefined
    );

    const rawBody = normalizeContent(payload.content).trim();
    if (!rawBody) {
        return;
    }

    const isGroup = Boolean(payload.groupId) || targetKind === 'panel';
    const wasMentioned = resolveWasMentioned(payload);
    const requireMention =
        targetKind === 'panel' &&
        isGroup &&
        resolveRequireMention(sessionId, payload.groupId ? String(payload.groupId) : undefined);

    const useDelay = targetKind === 'panel' && config.replyDelayMode === 'non-mention';

    if (requireMention && !wasMentioned && !useDelay) {
        log('DEBUG', `Drop panel message (mention required): ${sessionId}`);
        return;
    }

    const entry = {
        rawBody,
        author,
        senderName: senderName || undefined,
        senderUsername,
        timestamp: parseTimestamp(event.timestamp),
        messageId: payload.messageId ? String(payload.messageId) : undefined,
        groupId: isGroup ? String(payload.groupId || sessionId) : undefined,
    };

    if (useDelay) {
        const delayKey = `${targetKind}:${sessionId}`;
        const onFlush = async (entries, reason) => {
            await dispatchBufferedEntries({
                targetKind,
                targetId: sessionId,
                entries,
                isGroup,
                wasMentioned: reason === 'mention',
            });
        };

        if (wasMentioned) {
            await flushDelayedEntries({
                key: delayKey,
                entry,
                reason: 'mention',
                onFlush,
            });
        } else {
            await enqueueDelayedEntry({
                key: delayKey,
                entry,
                delayMs: config.replyDelayMs,
                onFlush,
            });
        }

        return;
    }

    await dispatchBufferedEntries({
        targetKind,
        targetId: sessionId,
        entries: [entry],
        isGroup,
        wasMentioned,
    });
}

const CURSOR_STORE_SCHEMA_VERSION = 1;
const CURSOR_PERSIST_DEBOUNCE_MS = 500;
const MESSAGE_DEDUPE_LIMIT = 2000;
const CONVERSE_LOOKUP_RETRY_MS = 15000;

const cursorBySession = new Map();
const coldSessionSet = new Set();
const queueBySession = new Map();
const recentMessageIdQueueBySession = new Map();
const recentMessageIdSetBySession = new Map();
const sessionIdByConverseId = new Map();
const converseLookupRetryAt = new Map();
const sessionSet = new Set(config.sessions.map((id) => String(id)));
const panelSet = new Set(config.panels.map((id) => String(id)));

let refreshTimer = null;
let cursorPersistTimer = null;
let cursorPersistQueue = Promise.resolve();
let outgoingProcessing = false;
let socketClient = null;
let stopped = false;

function rememberMessageId(sessionId, messageId) {
    if (!messageId) {
        return false;
    }

    let seenSet = recentMessageIdSetBySession.get(sessionId);
    let queue = recentMessageIdQueueBySession.get(sessionId);

    if (!seenSet || !queue) {
        seenSet = new Set();
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
}

async function loadPersistedCursors() {
    try {
        const text = await fs.promises.readFile(CURSOR_STORE_FILE, 'utf8');
        const parsed = JSON.parse(text);
        const cursors = parsed && parsed.cursors && typeof parsed.cursors === 'object'
            ? parsed.cursors
            : {};

        for (const [sessionId, rawCursor] of Object.entries(cursors)) {
            if (typeof rawCursor === 'number' && Number.isFinite(rawCursor) && rawCursor >= 0) {
                cursorBySession.set(sessionId, Math.floor(rawCursor));
            }
        }

        if (cursorBySession.size > 0) {
            log('INFO', `Restored ${cursorBySession.size} session cursors`);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            log('ERROR', `Failed loading cursor store: ${error.message}`);
        }
    }
}

async function persistCursors() {
    const cursors = {};
    for (const [sessionId, cursor] of cursorBySession.entries()) {
        if (typeof cursor === 'number' && Number.isFinite(cursor) && cursor >= 0) {
            cursors[sessionId] = Math.floor(cursor);
        }
    }

    const payload = {
        schemaVersion: CURSOR_STORE_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        cursors,
    };

    try {
        await fs.promises.mkdir(path.dirname(CURSOR_STORE_FILE), { recursive: true });
        await fs.promises.writeFile(CURSOR_STORE_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (error) {
        log('ERROR', `Failed writing cursor store: ${error.message}`);
    }
}

function scheduleCursorPersist() {
    if (stopped || cursorPersistTimer) {
        return;
    }

    cursorPersistTimer = setTimeout(() => {
        cursorPersistTimer = null;
        cursorPersistQueue = cursorPersistQueue.then(() => persistCursors());
    }, CURSOR_PERSIST_DEBOUNCE_MS);
}

async function flushCursorPersist() {
    if (cursorPersistTimer) {
        clearTimeout(cursorPersistTimer);
        cursorPersistTimer = null;
    }
    cursorPersistQueue = cursorPersistQueue.then(() => persistCursors());
    await cursorPersistQueue;
}

function collectCursors() {
    const snapshot = {};
    for (const [sessionId, cursor] of cursorBySession.entries()) {
        snapshot[sessionId] = cursor;
    }
    return snapshot;
}

function normalizeSessions(data) {
    if (!data) {
        return [];
    }
    if (Array.isArray(data)) {
        return data;
    }
    if (data && Array.isArray(data.sessions)) {
        return data.sessions;
    }
    return [data];
}

function buildCursorFromPayload(payload, lastCursor) {
    let nextCursor = lastCursor;

    if (typeof payload.cursor === 'number') {
        nextCursor = Math.max(nextCursor, payload.cursor);
    }

    for (const event of payload.events || []) {
        if (typeof event.seq === 'number') {
            nextCursor = Math.max(nextCursor, event.seq);
        }
    }

    return nextCursor;
}

function resolveMessageId(event) {
    const value = event && event.payload ? event.payload.messageId : undefined;
    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }
    return '';
}

function enqueueBySession(sessionId, task) {
    const previous = queueBySession.get(sessionId) || Promise.resolve();
    const next = previous.then(task, task);
    queueBySession.set(sessionId, next.catch(() => undefined));
}

function trackSessionDirectory(sessions) {
    const newSessions = [];
    let mappedConverse = 0;

    for (const session of sessions) {
        const sessionId = typeof session.sessionId === 'string' ? session.sessionId.trim() : '';
        if (!sessionId) {
            continue;
        }

        if (!sessionSet.has(sessionId)) {
            sessionSet.add(sessionId);
            newSessions.push(sessionId);
        }

        const converseId = typeof session.converseId === 'string' ? session.converseId.trim() : '';
        if (converseId) {
            sessionIdByConverseId.set(converseId, sessionId);
            mappedConverse += 1;
        }
    }

    return { newSessions, mappedConverse };
}

function applyEvents(payload, targetKind = 'session') {
    if (!payload || typeof payload !== 'object') {
        return;
    }

    const sessionId = payload.sessionId;
    if (!sessionId) {
        return;
    }

    const lastCursor = cursorBySession.get(sessionId) || 0;
    const payloadCursor = typeof payload.cursor === 'number' && Number.isFinite(payload.cursor)
        ? payload.cursor
        : undefined;
    const cursorRegressed = typeof payloadCursor === 'number' && payloadCursor < lastCursor;

    const isColdSession = targetKind === 'session' && coldSessionSet.has(sessionId);
    const nextCursor = cursorRegressed
        ? Math.max(0, Math.floor(payloadCursor || 0))
        : buildCursorFromPayload(payload, lastCursor);

    cursorBySession.set(sessionId, nextCursor);
    scheduleCursorPersist();

    if (isColdSession) {
        coldSessionSet.delete(sessionId);
        if ((payload.events || []).length > 0) {
            log('INFO', `Skipped bootstrap history for ${sessionId} (${payload.events.length} events)`);
        }
        return;
    }

    const rawEvents = payload.events || [];
    const events = rawEvents.filter((event) => {
        if (cursorRegressed) {
            return true;
        }
        if (typeof event.seq === 'number') {
            return event.seq > lastCursor;
        }
        return true;
    });

    if (!events.length) {
        return;
    }

    enqueueBySession(sessionId, async () => {
        for (const event of events) {
            if (!event || event.type !== 'message.add') {
                continue;
            }

            const messageId = resolveMessageId(event);
            if (messageId && rememberMessageId(sessionId, messageId)) {
                continue;
            }

            try {
                await handleInboundMessage({
                    targetKind,
                    sessionId,
                    event,
                });
            } catch (error) {
                log('ERROR', `Failed handling ${targetKind} event ${sessionId}: ${error.message}`);
            }
        }
    });
}

function subscribeSessions(socket, sessionIds) {
    if (!sessionIds.length) {
        return;
    }

    const cursors = collectCursors();
    for (const sessionId of sessionIds) {
        if (typeof cursors[sessionId] !== 'number') {
            coldSessionSet.add(sessionId);
        }
    }

    socket.emit(
        'com.claw.im.subscribeSessions',
        {
            sessionIds,
            cursors,
            limit: config.watchLimit,
        },
        (ack) => {
            if (!ack || !ack.result) {
                const message = (ack && ack.message) || 'subscribe sessions failed';
                log('ERROR', `Mochat session subscribe failed: ${message}`);
                return;
            }

            for (const session of normalizeSessions(ack.data)) {
                applyEvents(session, 'session');
            }
        },
    );
}

function subscribePanels(socket, panelIds) {
    if (!config.autoDiscoverPanels && !panelIds.length) {
        return;
    }

    socket.emit(
        'com.claw.im.subscribePanels',
        { panelIds },
        (ack) => {
            if (!ack || !ack.result) {
                const message = (ack && ack.message) || 'subscribe panels failed';
                log('ERROR', `Mochat panel subscribe failed: ${message}`);
            }
        },
    );
}

async function refreshSessionDirectory(socket, reason) {
    const response = await listSessions();
    const sessions = Array.isArray(response.sessions) ? response.sessions : [];
    const { newSessions, mappedConverse } = trackSessionDirectory(sessions);

    if (newSessions.length > 0 && socket) {
        subscribeSessions(socket, newSessions);
    }

    if (newSessions.length > 0 || mappedConverse > 0) {
        log('INFO', `Session directory refreshed (${reason}): total=${sessions.length}, new=${newSessions.length}`);
    }
}

async function resolveSessionIdByConverse(socket, converseId) {
    const cached = sessionIdByConverseId.get(converseId);
    if (cached) {
        return cached;
    }

    const now = Date.now();
    const nextRetryAt = converseLookupRetryAt.get(converseId) || 0;
    if (nextRetryAt > now) {
        return undefined;
    }

    converseLookupRetryAt.set(converseId, now + CONVERSE_LOOKUP_RETRY_MS);

    try {
        await refreshSessionDirectory(socket, `resolve-converse:${converseId}`);
    } catch (error) {
        log('ERROR', `Failed resolving converse ${converseId}: ${error.message}`);
        return undefined;
    }

    return sessionIdByConverseId.get(converseId);
}

function resolveTextPanelIds(rawPanels) {
    if (!Array.isArray(rawPanels)) {
        return [];
    }

    return rawPanels
        .map((panel) => ({
            id: String((panel && (panel.id || panel._id)) || '').trim(),
            type: panel && typeof panel.type === 'number' ? panel.type : undefined,
        }))
        .filter((panel) => panel.id && (panel.type === undefined || panel.type === 0))
        .map((panel) => panel.id);
}

async function refreshPanels(socket) {
    if (!config.autoDiscoverPanels) {
        return;
    }

    try {
        const groupInfo = await getWorkspaceGroup();
        const panelIds = resolveTextPanelIds(groupInfo.panels || []);
        const newPanels = [];

        for (const panelId of panelIds) {
            if (!panelSet.has(panelId)) {
                panelSet.add(panelId);
                newPanels.push(panelId);
            }
        }

        if (newPanels.length) {
            subscribePanels(socket, newPanels);
            log('INFO', `Discovered ${newPanels.length} new panel(s)`);
        }
    } catch (error) {
        log('ERROR', `Panel refresh failed: ${error.message}`);
    }
}

async function refreshSessions(socket) {
    if (!config.autoDiscoverSessions) {
        return;
    }

    try {
        await refreshSessionDirectory(socket, 'auto-discover');
    } catch (error) {
        log('ERROR', `Session refresh failed: ${error.message}`);
    }
}

async function refreshTargets(socket) {
    await Promise.all([
        refreshSessions(socket),
        refreshPanels(socket),
    ]);
}

function setupSocketClient() {
    const socketUrl = config.socketUrl.replace(/\/+$/, '');

    socketClient = io(socketUrl, {
        path: config.socketPath,
        transports: ['websocket'],
        parser: config.socketDisableMsgpack ? undefined : msgpackParser,
        auth: {
            token: config.clawToken,
        },
        autoConnect: false,
        reconnection: true,
        reconnectionAttempts: config.maxRetryAttempts > 0 ? config.maxRetryAttempts : undefined,
        reconnectionDelay: config.socketReconnectDelayMs,
        reconnectionDelayMax: config.socketMaxReconnectDelayMs,
        timeout: config.socketConnectTimeoutMs,
    });

    const subscribeAll = (socket) => {
        subscribeSessions(socket, Array.from(sessionSet));
        subscribePanels(socket, Array.from(panelSet));

        if (config.autoDiscoverSessions || config.autoDiscoverPanels) {
            void refreshTargets(socket);

            if (refreshTimer) {
                clearInterval(refreshTimer);
            }

            refreshTimer = setInterval(() => {
                if (stopped) {
                    return;
                }
                void refreshTargets(socket);
            }, config.refreshIntervalMs);
        }
    };

    socketClient.on('connect', () => {
        log('INFO', 'Mochat socket connected');
        subscribeAll(socketClient);
    });

    socketClient.on('connect_error', (err) => {
        const message = err instanceof Error ? err.message : String(err);
        log('ERROR', `Mochat socket connect failed: ${message}`);
    });

    socketClient.on('disconnect', (reason) => {
        if (!stopped) {
            log('WARN', `Mochat socket disconnected (${reason})`);
        }
    });

    socketClient.on('claw.session.events', (payload) => {
        if (stopped) {
            return;
        }
        log('INFO', `recv claw.session.events session=${payload && payload.sessionId ? payload.sessionId : 'unknown'} events=${payload && payload.events ? payload.events.length : 0}`);
        applyEvents(payload, 'session');
    });

    socketClient.on('claw.panel.events', (payload) => {
        if (stopped) {
            return;
        }
        log('INFO', `recv claw.panel.events panel=${payload && payload.sessionId ? payload.sessionId : 'unknown'} events=${payload && payload.events ? payload.events.length : 0}`);
        applyEvents(payload, 'panel');
    });

    socketClient.onAny((eventName, payload) => {
        if (stopped || typeof eventName !== 'string' || !eventName.startsWith('notify:')) {
            return;
        }

        if (eventName === 'notify:chat.inbox.append') {
            if (!payload || typeof payload !== 'object' || payload.type !== 'message' || !payload.payload) {
                return;
            }

            const detail = payload.payload;
            const converseId = typeof detail.converseId === 'string' ? detail.converseId.trim() : '';
            if (!converseId) {
                return;
            }

            const groupId = typeof detail.groupId === 'string' ? detail.groupId.trim() : '';
            if (groupId) {
                return;
            }

            void (async () => {
                const sessionId = await resolveSessionIdByConverse(socketClient, converseId);
                if (!sessionId) {
                    return;
                }

                const messageId =
                    (typeof detail.messageId === 'string' && detail.messageId.trim()) ||
                    (typeof payload._id === 'string' && payload._id.trim()) ||
                    '';

                if (messageId && rememberMessageId(sessionId, messageId)) {
                    return;
                }

                const author = typeof detail.messageAuthor === 'string' ? detail.messageAuthor.trim() : '';
                if (!author) {
                    return;
                }

                const content =
                    (typeof detail.messagePlainContent === 'string' && detail.messagePlainContent.trim()
                        ? detail.messagePlainContent
                        : undefined) ||
                    (typeof detail.messageSnippet === 'string' ? detail.messageSnippet : '');

                const syntheticEvent = {
                    seq: 0,
                    sessionId,
                    type: 'message.add',
                    timestamp: typeof payload.createdAt === 'string' ? payload.createdAt : new Date().toISOString(),
                    payload: {
                        messageId: messageId || undefined,
                        author,
                        content,
                        meta: {
                            sourceEvent: eventName,
                            sourceType: 'inbox-append',
                            converseId,
                        },
                        converseId,
                    },
                };

                enqueueBySession(sessionId, async () => {
                    try {
                        await handleInboundMessage({
                            targetKind: 'session',
                            sessionId,
                            event: syntheticEvent,
                        });
                    } catch (error) {
                        log('ERROR', `Failed inbox-append session event ${sessionId}: ${error.message}`);
                    }
                });
            })().catch((error) => {
                log('ERROR', `Inbox-append handler crashed: ${error.message}`);
            });

            return;
        }

        if (eventName.startsWith('notify:chat.message.')) {
            if (!payload || typeof payload !== 'object') {
                return;
            }

            const groupId = payload.groupId ? String(payload.groupId) : '';
            const panelId = payload.converseId ? String(payload.converseId) : '';
            if (!groupId || !panelId) {
                return;
            }

            if (panelSet.size > 0 && !panelSet.has(panelId)) {
                return;
            }

            const event = {
                seq: 0,
                sessionId: panelId,
                type: 'message.add',
                timestamp: typeof payload.createdAt === 'string' ? payload.createdAt : new Date().toISOString(),
                payload: {
                    messageId: String(payload._id || payload.messageId || ''),
                    author: payload.author ? String(payload.author) : '',
                    authorInfo: payload.authorInfo || undefined,
                    content: payload.content,
                    meta: payload.meta || {},
                    groupId,
                    converseId: panelId,
                },
            };

            const messageId = resolveMessageId(event);
            if (messageId && rememberMessageId(panelId, messageId)) {
                return;
            }

            enqueueBySession(panelId, async () => {
                try {
                    await handleInboundMessage({
                        targetKind: 'panel',
                        sessionId: panelId,
                        event,
                    });
                } catch (error) {
                    log('ERROR', `Failed notify panel event ${panelId}: ${error.message}`);
                }
            });
        }
    });

    socketClient.connect();
}

async function checkOutgoingQueue() {
    if (outgoingProcessing) {
        return;
    }

    outgoingProcessing = true;

    try {
        const files = fs.readdirSync(QUEUE_OUTGOING)
            .filter((file) => file.startsWith('mochat_') && file.endsWith('.json'));

        for (const file of files) {
            const filePath = path.join(QUEUE_OUTGOING, file);

            try {
                const responseData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                const { messageId, message: responseText, sender } = responseData;

                const pending = pendingMessages.get(messageId);
                if (!pending) {
                    log('WARN', `No pending Mochat message for ${messageId}, cleaning ${file}`);
                    fs.unlinkSync(filePath);
                    continue;
                }

                const text = typeof responseText === 'string' ? responseText.trim() : '';
                if (!text) {
                    pendingMessages.delete(messageId);
                    fs.unlinkSync(filePath);
                    continue;
                }

                if (pending.targetKind === 'panel') {
                    await sendPanelMessage({
                        panelId: pending.targetId,
                        content: text,
                        replyTo: pending.replyTo,
                        groupId: pending.groupId,
                    });
                } else {
                    await sendSessionMessage({
                        sessionId: pending.targetId,
                        content: text,
                        replyTo: pending.replyTo,
                    });
                }

                log('INFO', `✓ Sent Mochat response to ${sender || pending.targetId} (${text.length} chars)`);
                pendingMessages.delete(messageId);
                fs.unlinkSync(filePath);
            } catch (error) {
                log('ERROR', `Outgoing Mochat response failed (${file}): ${error.message}`);
            }
        }
    } catch (error) {
        log('ERROR', `Outgoing queue read failed: ${error.message}`);
    } finally {
        outgoingProcessing = false;
    }
}

async function shutdown() {
    if (stopped) {
        return;
    }

    stopped = true;
    log('INFO', 'Shutting down Mochat client...');

    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }

    for (const state of delayBuffers.values()) {
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
    }

    if (socketClient) {
        try {
            socketClient.disconnect();
        } catch (_) {
            // Ignore disconnect errors during shutdown.
        }
    }

    await flushCursorPersist();
    process.exit(0);
}

function validateConfig() {
    if (!config.enabled) {
        log('INFO', 'Mochat disabled (MOCHAT_ENABLED=false), exiting.');
        return { ok: false, exitCode: 0 };
    }

    if (!config.clawToken) {
        log('ERROR', 'Missing MOCHAT_CLAW_TOKEN');
        return { ok: false, exitCode: 1 };
    }

    if (!config.agentUserId) {
        log('ERROR', 'Missing MOCHAT_AGENT_USER_ID');
        return { ok: false, exitCode: 1 };
    }

    const hasTargets =
        config.sessions.length > 0 ||
        config.panels.length > 0 ||
        config.autoDiscoverSessions ||
        config.autoDiscoverPanels;

    if (!hasTargets) {
        log('ERROR', 'No Mochat targets configured. Set MOCHAT_SESSIONS or MOCHAT_PANELS (supports ["*"]).');
        return { ok: false, exitCode: 1 };
    }

    return { ok: true, exitCode: 0 };
}

async function start() {
    log('INFO', 'Starting Mochat client...');

    const validation = validateConfig();
    if (!validation.ok) {
        process.exit(validation.exitCode);
    }

    log('INFO', `Config: baseUrl=${config.baseUrl}, socket=${config.socketUrl}${config.socketPath}`);
    log('INFO', `Targets: sessions=${config.sessions.length}${config.autoDiscoverSessions ? ' (+auto)' : ''}, panels=${config.panels.length}${config.autoDiscoverPanels ? ' (+auto)' : ''}`);
    log('INFO', `Reply mode: ${config.replyDelayMode}, delay=${config.replyDelayMs}ms`);

    await loadPersistedCursors();
    setupSocketClient();

    setInterval(() => {
        checkOutgoingQueue().catch((error) => {
            log('ERROR', `Outgoing queue async error: ${error.message}`);
        });
    }, 1000);

    setInterval(cleanupPendingMessages, 10000);
}

process.on('SIGINT', () => {
    shutdown().catch((error) => {
        log('ERROR', `Shutdown error: ${error.message}`);
        process.exit(1);
    });
});

process.on('SIGTERM', () => {
    shutdown().catch((error) => {
        log('ERROR', `Shutdown error: ${error.message}`);
        process.exit(1);
    });
});

start().catch((error) => {
    log('ERROR', `Fatal startup error: ${error.message}`);
    process.exit(1);
});
