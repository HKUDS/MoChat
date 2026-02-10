#!/usr/bin/env node
/**
 * Queue Processor - Handles messages from Mochat channel
 * Processes one message at a time to avoid race conditions
 */
export {};

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const QUEUE_INCOMING = path.join(SCRIPT_DIR, '.claudeclaw/queue/incoming');
const QUEUE_OUTGOING = path.join(SCRIPT_DIR, '.claudeclaw/queue/outgoing');
const QUEUE_PROCESSING = path.join(SCRIPT_DIR, '.claudeclaw/queue/processing');
const LOG_FILE = path.join(SCRIPT_DIR, '.claudeclaw/logs/queue.log');
const RESET_FLAG = path.join(SCRIPT_DIR, '.claudeclaw/reset_flag');
const STATE_DIR = path.join(SCRIPT_DIR, '.claudeclaw/state');
const SESSION_STORE_FILE = path.join(STATE_DIR, 'claude_sessions.json');
const SYSTEM_PROMPT_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md'];

// Ensure directories exist
[QUEUE_INCOMING, QUEUE_OUTGOING, QUEUE_PROCESSING, path.dirname(LOG_FILE), STATE_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Logger
function log(level, message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    fs.appendFileSync(LOG_FILE, logMessage);
}

function loadSessionStore() {
    try {
        if (!fs.existsSync(SESSION_STORE_FILE)) {
            return { version: 1, updatedAt: Date.now(), sessions: {} };
        }
        const parsed = JSON.parse(fs.readFileSync(SESSION_STORE_FILE, 'utf8'));
        if (!parsed || typeof parsed !== 'object') {
            return { version: 1, updatedAt: Date.now(), sessions: {} };
        }
        const sessions = parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
        return {
            version: 1,
            updatedAt: Date.now(),
            sessions
        };
    } catch (error) {
        log('WARN', `Failed to load session store: ${error.message}`);
        return { version: 1, updatedAt: Date.now(), sessions: {} };
    }
}

function saveSessionStore(store) {
    try {
        store.updatedAt = Date.now();
        fs.writeFileSync(SESSION_STORE_FILE, JSON.stringify(store, null, 2));
    } catch (error) {
        log('WARN', `Failed to save session store: ${error.message}`);
    }
}

const sessionStore = loadSessionStore();

function resolveSessionKey(messageData) {
    const channel = String(messageData.channel || 'unknown');
    const sender = String(messageData.sender || 'unknown');
    const senderId = messageData.senderId ? String(messageData.senderId) : '';
    const metadata = messageData.metadata && typeof messageData.metadata === 'object'
        ? messageData.metadata
        : {};

    if (channel === 'mochat') {
        const targetKind = metadata.targetKind ? String(metadata.targetKind) : 'session';
        const targetId = metadata.targetId ? String(metadata.targetId) : (senderId || sender);
        return `mochat:${targetKind}:${targetId}`;
    }

    if (channel === 'heartbeat') {
        return 'heartbeat:system';
    }

    return `${channel}:${senderId || sender}`;
}

function buildSystemPrompt(messageData, sessionKey) {
    const sections = [];

    for (const fileName of SYSTEM_PROMPT_FILES) {
        const filePath = path.join(SCRIPT_DIR, fileName);
        if (!fs.existsSync(filePath)) {
            continue;
        }
        try {
            const content = fs.readFileSync(filePath, 'utf8').trim();
            if (content) {
                sections.push(`## ${fileName}\n\n${content}`);
            }
        } catch (error) {
            log('WARN', `Failed to read ${fileName}: ${error.message}`);
        }
    }

    if (!sections.length) {
        return '';
    }

    const channel = String(messageData.channel || 'unknown');
    const sender = String(messageData.sender || 'unknown');
    const senderId = messageData.senderId ? String(messageData.senderId) : '';
    const metadata = messageData.metadata && typeof messageData.metadata === 'object'
        ? messageData.metadata
        : {};

    const contextLines = [
        `Channel: ${channel}`,
        `Session Key: ${sessionKey}`,
        `Sender: ${sender}`,
    ];

    if (senderId) {
        contextLines.push(`Sender ID: ${senderId}`);
    }

    if (channel === 'mochat') {
        if (metadata.targetKind) {
            contextLines.push(`Target Kind: ${String(metadata.targetKind)}`);
        }
        if (metadata.targetId) {
            contextLines.push(`Target ID: ${String(metadata.targetId)}`);
        }
    }

    sections.push(`## Current Session\n${contextLines.join('\n')}`);
    return sections.join('\n\n---\n\n');
}

function parseClaudeResult(outputText) {
    const trimmed = (outputText || '').trim();
    if (!trimmed) {
        throw new Error('Empty response from Claude');
    }

    // Primary: full output is JSON.
    try {
        const parsed = JSON.parse(trimmed);
        return {
            text: typeof parsed.result === 'string' ? parsed.result : String(parsed.result || ''),
            sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
        };
    } catch (_) {
        // Fallback: parse the last JSON-looking line if extra logs appeared.
    }

    const lines = trimmed.split('\n').map(line => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.startsWith('{') || !line.endsWith('}')) {
            continue;
        }
        try {
            const parsed = JSON.parse(line);
            return {
                text: typeof parsed.result === 'string' ? parsed.result : String(parsed.result || ''),
                sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
            };
        } catch (_) {
            // keep searching
        }
    }

    throw new Error('Failed to parse Claude JSON output');
}

function runClaudePrompt({ prompt, resumeSessionId, systemPrompt }) {
    const args = ['--dangerously-skip-permissions', '-p', '--output-format', 'json'];
    if (systemPrompt) {
        args.push('--append-system-prompt', systemPrompt);
    }
    if (resumeSessionId) {
        args.push('-r', resumeSessionId);
    }
    args.push(prompt);

    const stdout = execFileSync('claude', args, {
        cwd: SCRIPT_DIR,
        encoding: 'utf-8',
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
    });

    return parseClaudeResult(stdout);
}

// Process a single message
async function processMessage(messageFile) {
    const processingFile = path.join(QUEUE_PROCESSING, path.basename(messageFile));

    try {
        // Move to processing to mark as in-progress
        fs.renameSync(messageFile, processingFile);

        // Read message
        const messageData = JSON.parse(fs.readFileSync(processingFile, 'utf8'));
        const { channel, sender, message, timestamp, messageId } = messageData;
        const sessionKey = resolveSessionKey(messageData);

        log('INFO', `Processing [${channel}] from ${sender}: ${message.substring(0, 50)}...`);

        // Check if we should reset conversation for the next routed session.
        const shouldReset = fs.existsSync(RESET_FLAG);

        if (shouldReset) {
            log('INFO', `🔄 Resetting routed session: ${sessionKey}`);
            fs.unlinkSync(RESET_FLAG);
            delete sessionStore.sessions[sessionKey];
            saveSessionStore(sessionStore);
        }

        // Call Claude
        let response;
        try {
            const previousSessionId = shouldReset
                ? null
                : (sessionStore.sessions[sessionKey] && sessionStore.sessions[sessionKey].sessionId
                    ? sessionStore.sessions[sessionKey].sessionId
                    : null);

            if (previousSessionId) {
                log('DEBUG', `Resuming Claude session for ${sessionKey}: ${previousSessionId}`);
            } else {
                log('DEBUG', `Starting new Claude session for ${sessionKey}`);
            }

            const claudeResult = runClaudePrompt({
                prompt: message,
                resumeSessionId: previousSessionId,
                systemPrompt: buildSystemPrompt(messageData, sessionKey),
            });

            response = (claudeResult.text || '').trim();

            if (claudeResult.sessionId) {
                sessionStore.sessions[sessionKey] = {
                    channel,
                    sessionId: claudeResult.sessionId,
                    updatedAt: Date.now(),
                };
                saveSessionStore(sessionStore);
            }
        } catch (error) {
            log('ERROR', `Claude error: ${error.message}`);
            response = "Sorry, I encountered an error processing your request.";
        }

        // Limit response length
        if (response.length > 4000) {
            response = response.substring(0, 3900) + '\n\n[Response truncated...]';
        }

        // Write response to outgoing queue
        const responseData = {
            channel,
            sender,
            message: response,
            originalMessage: message,
            timestamp: Date.now(),
            messageId
        };

        // For heartbeat messages, write to a separate location (they handle their own responses)
        const responseFile = channel === 'heartbeat'
            ? path.join(QUEUE_OUTGOING, `${messageId}.json`)
            : path.join(QUEUE_OUTGOING, `${channel}_${messageId}_${Date.now()}.json`);

        fs.writeFileSync(responseFile, JSON.stringify(responseData, null, 2));

        log('INFO', `✓ Response ready [${channel}] ${sender} (${response.length} chars)`);

        // Clean up processing file
        fs.unlinkSync(processingFile);

    } catch (error) {
        log('ERROR', `Processing error: ${error.message}`);

        // Move back to incoming for retry
        if (fs.existsSync(processingFile)) {
            try {
                fs.renameSync(processingFile, messageFile);
            } catch (e) {
                log('ERROR', `Failed to move file back: ${e.message}`);
            }
        }
    }
}

// Main processing loop
async function processQueue() {
    try {
        // Get all files from incoming queue, sorted by timestamp
        const files = fs.readdirSync(QUEUE_INCOMING)
            .filter(f => f.endsWith('.json'))
            .map(f => ({
                name: f,
                path: path.join(QUEUE_INCOMING, f),
                time: fs.statSync(path.join(QUEUE_INCOMING, f)).mtimeMs
            }))
            .sort((a, b) => a.time - b.time);

        if (files.length > 0) {
            log('DEBUG', `Found ${files.length} message(s) in queue`);

            // Process one at a time
            for (const file of files) {
                await processMessage(file.path);
            }
        }
    } catch (error) {
        log('ERROR', `Queue processing error: ${error.message}`);
    }
}

// Main loop
log('INFO', 'Queue processor started');
log('INFO', `Watching: ${QUEUE_INCOMING}`);

// Process queue every 1 second
setInterval(processQueue, 1000);

// Graceful shutdown
process.on('SIGINT', () => {
    log('INFO', 'Shutting down queue processor...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('INFO', 'Shutting down queue processor...');
    process.exit(0);
});
