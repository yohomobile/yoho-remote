import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { configuration } from '@/configuration';

export const SYSTEMD_SERVICE_NAME = 'yoho-remote-daemon.service';
export const SYSTEMD_SERVICE_PATH = `/etc/systemd/system/${SYSTEMD_SERVICE_NAME}`;

export type InstallContext = {
    envFilePath: string
    execParts: string[]
    serviceUser: string
    workingDirectory: string
}

export type SystemdFileWriteResult = {
    changed: boolean
    existed: boolean
}

export type PreparedSystemdInstall = InstallContext & {
    envFileChanged: boolean
}

function quoteSystemdValue(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

function ensureSystemctlAvailable(): void {
    try {
        execFileSync('systemctl', ['--version'], { stdio: 'ignore' });
    } catch {
        throw new Error('systemctl is required for Linux daemon installation');
    }
}

function getServiceUser(): string {
    return process.env.SUDO_USER || os.userInfo().username;
}

function getServiceHomeDir(serviceUser: string): string {
    try {
        const passwdEntry = execFileSync('getent', ['passwd', serviceUser], { encoding: 'utf8' }).trim();
        const fields = passwdEntry.split(':');
        if (fields.length >= 6 && fields[5]) {
            return fields[5];
        }
    } catch {
        // Fall through to conventional defaults below.
    }

    return serviceUser === 'root' ? '/root' : `/home/${serviceUser}`;
}

function getServiceYohoHomeDir(serviceUser: string): string {
    if (process.env.YOHO_REMOTE_HOME) {
        return configuration.yohoRemoteHomeDir;
    }
    return join(getServiceHomeDir(serviceUser), '.yoho-remote');
}

export function getSystemdEnvFilePath(serviceUser?: string): string {
    return join(getServiceYohoHomeDir(serviceUser ?? getServiceUser()), 'daemon.systemd.env');
}

function readPersistedToken(serviceUser: string): string | undefined {
    const settingsFile = join(getServiceYohoHomeDir(serviceUser), 'settings.json');
    if (!existsSync(settingsFile)) {
        return undefined;
    }
    try {
        const raw = JSON.parse(readFileSync(settingsFile, 'utf8')) as { cliApiToken?: string };
        return raw.cliApiToken?.trim() || undefined;
    } catch {
        return undefined;
    }
}

function getExecParts(): string[] {
    const execPath = process.execPath;
    const scriptPath = process.argv[1];
    const parts = [execPath];

    if (scriptPath && scriptPath !== execPath) {
        parts.push(scriptPath);
    }

    parts.push('daemon', 'start-sync');
    return parts;
}

function formatExecStart(parts: string[]): string {
    return parts.map(quoteSystemdValue).join(' ');
}

function collectEnvEntries(serviceUser: string): Array<[string, string]> {
    const persistedToken = readPersistedToken(serviceUser);
    const token = process.env.CLI_API_TOKEN?.trim() || persistedToken;
    if (!token) {
        throw new Error('CLI_API_TOKEN is required before installing the daemon. Set it in the environment or run `hapi auth login` first.');
    }

    const entries = new Map<string, string>();
    entries.set('CLI_API_TOKEN', token);
    entries.set('YOHO_REMOTE_URL', configuration.serverUrl);
    entries.set('YOHO_REMOTE_HOME', getServiceYohoHomeDir(serviceUser));
    entries.set('HOME', getServiceHomeDir(serviceUser));
    entries.set('PATH', process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');

    const passthroughPrefixes = ['YOHO_', 'YR_', 'OPENAI_', 'ANTHROPIC_', 'GEMINI_', 'GOOGLE_', 'OPENROUTER_'];
    const passthroughKeys = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'CLAUDE_CODE_USE_BEDROCK'];
    for (const [key, value] of Object.entries(process.env)) {
        if (!value) continue;
        if (entries.has(key)) continue;
        if (passthroughKeys.includes(key) || passthroughPrefixes.some(prefix => key.startsWith(prefix))) {
            entries.set(key, value);
        }
    }

    return Array.from(entries.entries()).sort(([a], [b]) => a.localeCompare(b));
}

function buildEnvFile(entries: Array<[string, string]>): string {
    return `${entries.map(([key, value]) => `${key}=${quoteSystemdValue(value)}`).join('\n')}\n`;
}

function writeTextFileIfChanged(path: string, content: string, mode: number): SystemdFileWriteResult {
    const existed = existsSync(path);
    const previous = existed ? readFileSync(path, 'utf8') : null;
    if (previous === content) {
        return { existed, changed: false };
    }

    writeFileSync(path, content, { mode });
    return { existed, changed: true };
}

function writeEnvFile(envFilePath: string, entries: Array<[string, string]>): SystemdFileWriteResult {
    const dir = dirname(envFilePath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    return writeTextFileIfChanged(envFilePath, buildEnvFile(entries), 0o600);
}

export function buildSystemdServiceFile(context: InstallContext): string {
    return `[Unit]
Description=Yoho Remote Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${context.serviceUser}
WorkingDirectory=${context.workingDirectory}
EnvironmentFile=${context.envFilePath}
Environment=YR_DAEMON_UNDER_SYSTEMD=1
ExecStart=${formatExecStart(context.execParts)}
Restart=always
KillMode=control-group
RestartSec=10

[Install]
WantedBy=multi-user.target
`;
}

export async function prepareSystemdInstall(): Promise<PreparedSystemdInstall> {
    ensureSystemctlAvailable();

    const serviceUser = getServiceUser();
    const yohoHomeDir = getServiceYohoHomeDir(serviceUser);
    const envFilePath = getSystemdEnvFilePath(serviceUser);
    const entries = collectEnvEntries(serviceUser);
    const envFileResult = writeEnvFile(envFilePath, entries);

    return {
        envFilePath,
        envFileChanged: envFileResult.changed,
        execParts: getExecParts(),
        serviceUser,
        workingDirectory: yohoHomeDir,
    };
}

export function writeSystemdServiceFile(context: InstallContext): SystemdFileWriteResult {
    return writeTextFileIfChanged(SYSTEMD_SERVICE_PATH, buildSystemdServiceFile(context), 0o644);
}

export function runSystemctl(args: string[]): void {
    execFileSync('systemctl', args, { stdio: 'inherit' });
}
