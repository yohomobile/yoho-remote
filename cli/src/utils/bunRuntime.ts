import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { isBunCompiled } from '@/projectPath';

export type BunRuntimeEnvOptions = {
    allowBunBeBun?: boolean;
};

type BunPathOptions = {
    homeDir?: string;
    pathExists?: (path: string) => boolean;
};

function stripBunBeBun(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (!('BUN_BE_BUN' in env)) {
        return env;
    }

    const copy = { ...env };
    delete copy.BUN_BE_BUN;
    return copy;
}

export function ensureBunBinPath(
    env: NodeJS.ProcessEnv = process.env,
    options: BunPathOptions = {}
): NodeJS.ProcessEnv {
    const homeDir = options.homeDir ?? env.HOME ?? homedir();
    const pathExists = options.pathExists ?? existsSync;
    const bunBinDir = join(homeDir, '.bun', 'bin');

    if (!pathExists(bunBinDir)) {
        return env;
    }

    const currentPath = env.PATH ?? '';
    const pathEntries = currentPath.split(delimiter).filter(Boolean);

    if (pathEntries.includes(bunBinDir)) {
        return env;
    }

    return {
        ...env,
        PATH: currentPath ? `${bunBinDir}${delimiter}${currentPath}` : bunBinDir
    };
}

export function withBunRuntimeEnv(
    env: NodeJS.ProcessEnv = process.env,
    options: BunRuntimeEnvOptions = {}
): NodeJS.ProcessEnv {
    const envWithBunPath = ensureBunBinPath(env);

    if (!isBunCompiled()) {
        return envWithBunPath;
    }

    if (options.allowBunBeBun === false) {
        return stripBunBeBun(envWithBunPath);
    }

    return {
        ...envWithBunPath,
        BUN_BE_BUN: '1'
    };
}
