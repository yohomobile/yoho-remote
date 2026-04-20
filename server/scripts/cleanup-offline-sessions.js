#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

function printUsage() {
    console.log(`
Usage: node server/scripts/cleanup-offline-sessions.js [options]

Options:
  --base-url=URL         API base URL (default: http://localhost:<webappPort>)
  --settings=PATH        Path to settings.json (default: ~/.hapi/settings.json or $YOHO_REMOTE_HOME)
  --token=TOKEN          CLI API token (default: $CLI_API_TOKEN or settings.json)
  --namespace=NAME       Namespace for access token (default: token namespace or "default")
  --min-idle-minutes=N   Only include sessions idle at least N minutes
  --limit=N              Max sessions to show/delete
  --delete               Permanently delete offline sessions (default: dry-run)
  --yes                  Skip confirmation prompt
  --force                Add force=1 to DELETE (removes in-memory sessions even if DB row is missing)
  --help                 Show this help message
`);
}

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        baseUrl: null,
        settingsPath: null,
        token: null,
        namespace: null,
        minIdleMinutes: null,
        limit: null,
        doDelete: false,
        yes: false,
        force: false,
        help: false
    };

    for (const arg of args) {
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--delete') {
            options.doDelete = true;
        } else if (arg === '--yes' || arg === '-y') {
            options.yes = true;
        } else if (arg === '--force') {
            options.force = true;
        } else if (arg.startsWith('--base-url=')) {
            options.baseUrl = arg.split('=').slice(1).join('=');
        } else if (arg.startsWith('--settings=')) {
            options.settingsPath = arg.split('=').slice(1).join('=');
        } else if (arg.startsWith('--token=')) {
            options.token = arg.split('=').slice(1).join('=');
        } else if (arg.startsWith('--namespace=')) {
            options.namespace = arg.split('=').slice(1).join('=');
        } else if (arg.startsWith('--min-idle-minutes=')) {
            const value = Number.parseInt(arg.split('=')[1], 10);
            if (!Number.isFinite(value) || value < 0) {
                console.error('Error: --min-idle-minutes must be a non-negative integer');
                process.exit(1);
            }
            options.minIdleMinutes = value;
        } else if (arg.startsWith('--limit=')) {
            const value = Number.parseInt(arg.split('=')[1], 10);
            if (!Number.isFinite(value) || value < 1) {
                console.error('Error: --limit must be a positive integer');
                process.exit(1);
            }
            options.limit = value;
        } else {
            console.error(`Unknown argument: ${arg}`);
            console.error('Use --help for usage information.');
            process.exit(1);
        }
    }

    return options;
}

function resolveSettingsPath(explicitPath) {
    if (explicitPath) {
        return explicitPath;
    }
    const dataDir = process.env.YOHO_REMOTE_HOME
        ? process.env.YOHO_REMOTE_HOME.replace(/^~/, os.homedir())
        : path.join(os.homedir(), '.hapi');
    return path.join(dataDir, 'settings.json');
}

function readSettings(settingsPath) {
    if (!settingsPath || !fs.existsSync(settingsPath)) {
        return {};
    }
    try {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

function normalizeBaseUrl(baseUrl) {
    return baseUrl.replace(/\/+$/, '');
}

function parseAccessToken(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const separatorIndex = trimmed.lastIndexOf(':');
    if (separatorIndex === -1) {
        return { baseToken: trimmed, namespace: 'default' };
    }
    const baseToken = trimmed.slice(0, separatorIndex);
    const namespace = trimmed.slice(separatorIndex + 1);
    if (!baseToken || !namespace) return null;
    return { baseToken, namespace };
}

function buildAccessToken(token, namespace) {
    const parsed = parseAccessToken(token);
    if (parsed && namespace && parsed.namespace !== namespace && parsed.baseToken) {
        return `${parsed.baseToken}:${namespace}`;
    }
    if (namespace && !token.includes(':')) {
        return `${token}:${namespace}`;
    }
    return token;
}

function requestJson(url, options) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const isHttps = target.protocol === 'https:';
        const client = isHttps ? https : http;
        const method = options.method || 'GET';
        const headers = { ...(options.headers || {}) };
        const body = options.body ?? null;

        if (body && !headers['content-type']) {
            headers['content-type'] = 'application/json';
        }
        if (body && !headers['content-length']) {
            headers['content-length'] = Buffer.byteLength(body);
        }

        const req = client.request({
            method,
            hostname: target.hostname,
            port: target.port || (isHttps ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            headers
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let data = null;
                if (text) {
                    try {
                        data = JSON.parse(text);
                    } catch {
                        data = null;
                    }
                }
                const status = res.statusCode || 0;
                const result = { status, ok: status >= 200 && status < 300, data, text };
                if (result.ok) {
                    resolve(result);
                } else {
                    reject(result);
                }
            });
        });

        req.on('error', reject);
        if (body) {
            req.write(body);
        }
        req.end();
    });
}

function minutesSince(epochMs, now) {
    if (!Number.isFinite(epochMs) || epochMs <= 0) {
        return null;
    }
    return Math.max(0, Math.floor((now - epochMs) / 60000));
}

function renderSessionsTable(sessions) {
    if (sessions.length === 0) {
        console.log('No offline sessions match the criteria.');
        return;
    }

    const rows = sessions.map((session) => ({
        id: session.id,
        idleMinutes: session.idleMinutes ?? '-',
        updatedMinutes: session.updatedMinutes ?? '-',
        name: session.name ?? '',
        path: session.path ?? ''
    }));

    const idWidth = Math.max(8, ...rows.map(r => r.id.length));
    const idleWidth = Math.max(8, ...rows.map(r => String(r.idleMinutes).length));
    const updatedWidth = Math.max(8, ...rows.map(r => String(r.updatedMinutes).length));
    const nameWidth = Math.max(4, ...rows.map(r => r.name.length));
    const pathWidth = Math.max(4, ...rows.map(r => r.path.length));

    const header = [
        'ID'.padEnd(idWidth),
        'IdleMin'.padStart(idleWidth),
        'UpdatedMin'.padStart(updatedWidth),
        'Name'.padEnd(nameWidth),
        'Path'.padEnd(pathWidth)
    ].join(' | ');
    console.log(header);
    console.log('-'.repeat(header.length));

    for (const row of rows) {
        console.log([
            row.id.padEnd(idWidth),
            String(row.idleMinutes).padStart(idleWidth),
            String(row.updatedMinutes).padStart(updatedWidth),
            row.name.padEnd(nameWidth),
            row.path.padEnd(pathWidth)
        ].join(' | '));
    }
}

async function confirm(message) {
    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`${message} [y/N]: `, (answer) => {
            rl.close();
            const normalized = answer.trim().toLowerCase();
            resolve(normalized === 'y' || normalized === 'yes');
        });
    });
}

async function main() {
    const options = parseArgs();
    if (options.help) {
        printUsage();
        return;
    }

    const settingsPath = resolveSettingsPath(options.settingsPath);
    const settings = readSettings(settingsPath);

    const token = options.token || process.env.CLI_API_TOKEN || settings.cliApiToken;
    if (!token) {
        console.error('Missing CLI API token. Provide --token or set CLI_API_TOKEN.');
        process.exit(1);
    }

    const accessToken = buildAccessToken(token, options.namespace);
    const parsedToken = parseAccessToken(accessToken);
    const namespace = parsedToken ? parsedToken.namespace : 'default';

    const baseUrl = normalizeBaseUrl(
        options.baseUrl || `http://localhost:${settings.webappPort || 3006}`
    );

    console.log(`Base URL: ${baseUrl}`);
    console.log(`Namespace: ${namespace}`);

    const authBody = JSON.stringify({
        accessToken,
        clientId: 'cleanup-script',
        deviceType: 'script'
    });

    let jwtToken;
    try {
        const authResponse = await requestJson(`${baseUrl}/api/auth`, {
            method: 'POST',
            body: authBody
        });
        jwtToken = authResponse.data?.token;
    } catch (error) {
        if (error && typeof error === 'object' && 'status' in error) {
            console.error(`Auth failed: HTTP ${error.status} ${error.text || ''}`.trim());
        } else {
            console.error(`Auth failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        process.exit(1);
    }

    if (!jwtToken) {
        console.error('Auth failed: missing token in response.');
        process.exit(1);
    }

    let sessions;
    try {
        const response = await requestJson(`${baseUrl}/api/sessions`, {
            headers: { authorization: `Bearer ${jwtToken}` }
        });
        sessions = response.data?.sessions;
    } catch (error) {
        if (error && typeof error === 'object' && 'status' in error) {
            console.error(`Fetch sessions failed: HTTP ${error.status} ${error.text || ''}`.trim());
        } else {
            console.error(`Fetch sessions failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        process.exit(1);
    }

    if (!Array.isArray(sessions)) {
        console.error('Unexpected sessions response.');
        process.exit(1);
    }

    const now = Date.now();
    let offline = sessions
        .filter(session => !session.active)
        .map(session => {
            const activeAt = Number(session.activeAt) || 0;
            const updatedAt = Number(session.updatedAt) || 0;
            const lastActivityAt = Math.max(activeAt, updatedAt);
            const idleMinutes = minutesSince(lastActivityAt, now);
            const updatedMinutes = minutesSince(updatedAt, now);
            const name = session.metadata?.name || '';
            const pathValue = session.metadata?.path || '';
            return {
                id: session.id,
                idleMinutes,
                updatedMinutes,
                name,
                path: pathValue,
                lastActivityAt
            };
        });

    if (options.minIdleMinutes !== null) {
        offline = offline.filter(session => (session.idleMinutes ?? 0) >= options.minIdleMinutes);
    }

    offline.sort((a, b) => a.lastActivityAt - b.lastActivityAt);

    if (options.limit !== null) {
        offline = offline.slice(0, options.limit);
    }

    console.log(`Total sessions: ${sessions.length}`);
    console.log(`Offline sessions: ${offline.length}`);
    if (options.minIdleMinutes !== null) {
        console.log(`Filter: idle >= ${options.minIdleMinutes} minutes`);
    }
    console.log('');

    renderSessionsTable(offline);

    if (!options.doDelete || offline.length === 0) {
        return;
    }

    if (!options.yes) {
        const confirmed = await confirm(`Delete ${offline.length} offline session(s)?`);
        if (!confirmed) {
            console.log('Aborted.');
            return;
        }
    }

    let deletedCount = 0;
    for (const session of offline) {
        const params = new URLSearchParams({ purge: '1' });
        if (options.force) {
            params.set('force', '1');
        }
        const deleteUrl = `${baseUrl}/api/sessions/${encodeURIComponent(session.id)}?${params.toString()}`;
        try {
            await requestJson(deleteUrl, {
                method: 'DELETE',
                headers: { authorization: `Bearer ${jwtToken}` }
            });
            deletedCount += 1;
            console.log(`Deleted ${session.id}`);
        } catch (error) {
            if (error && typeof error === 'object' && 'status' in error) {
                console.error(`Failed to delete ${session.id}: HTTP ${error.status} ${error.text || ''}`.trim());
            } else {
                console.error(`Failed to delete ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    console.log(`Deleted ${deletedCount} session(s).`);
}

main().catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
