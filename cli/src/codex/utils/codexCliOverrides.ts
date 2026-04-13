export type CodexCliOverrides = {
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
    serviceTier?: 'fast' | 'flex';
};

const SANDBOX_VALUES = new Set<CodexCliOverrides['sandbox']>([
    'read-only',
    'workspace-write',
    'danger-full-access'
]);

const APPROVAL_POLICY_VALUES = new Set<CodexCliOverrides['approvalPolicy']>([
    'untrusted',
    'on-failure',
    'on-request',
    'never'
]);

const SERVICE_TIER_VALUES = new Set<NonNullable<CodexCliOverrides['serviceTier']>>([
    'fast',
    'flex'
]);

function parseConfigOverride(
    rawValue: string | undefined,
    overrides: CodexCliOverrides
): void {
    if (!rawValue) {
        return;
    }

    const separatorIndex = rawValue.indexOf('=');
    if (separatorIndex === -1) {
        return;
    }

    const key = rawValue.slice(0, separatorIndex).trim();
    const value = rawValue
        .slice(separatorIndex + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '');

    if (key === 'service_tier' && SERVICE_TIER_VALUES.has(value as NonNullable<CodexCliOverrides['serviceTier']>)) {
        overrides.serviceTier = value as NonNullable<CodexCliOverrides['serviceTier']>;
    }
}

export function parseCodexCliOverrides(args?: string[]): CodexCliOverrides {
    const overrides: CodexCliOverrides = {};
    if (!args || args.length === 0) {
        return overrides;
    }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            break;
        }

        if (arg === '-c' || arg === '--config') {
            parseConfigOverride(args[i + 1], overrides);
            if (args[i + 1] !== undefined) {
                i += 1;
            }
            continue;
        }

        if (arg.startsWith('--config=')) {
            parseConfigOverride(arg.slice('--config='.length), overrides);
            continue;
        }

        if (arg === '--full-auto') {
            overrides.approvalPolicy = 'on-request';
            overrides.sandbox = 'workspace-write';
            continue;
        }

        if (arg === '--yolo') {
            overrides.approvalPolicy = 'never';
            overrides.sandbox = 'danger-full-access';
            continue;
        }

        if (arg === '--dangerously-bypass-approvals-and-sandbox') {
            overrides.approvalPolicy = 'never';
            overrides.sandbox = 'danger-full-access';
            continue;
        }

        if (arg === '-s' || arg === '--sandbox') {
            const value = args[i + 1];
            if (SANDBOX_VALUES.has(value as CodexCliOverrides['sandbox'])) {
                overrides.sandbox = value as CodexCliOverrides['sandbox'];
                i += 1;
            }
            continue;
        }

        if (arg.startsWith('--sandbox=')) {
            const value = arg.slice('--sandbox='.length);
            if (SANDBOX_VALUES.has(value as CodexCliOverrides['sandbox'])) {
                overrides.sandbox = value as CodexCliOverrides['sandbox'];
            }
            continue;
        }

        if (arg === '-a' || arg === '--ask-for-approval') {
            const value = args[i + 1];
            if (APPROVAL_POLICY_VALUES.has(value as CodexCliOverrides['approvalPolicy'])) {
                overrides.approvalPolicy = value as CodexCliOverrides['approvalPolicy'];
                i += 1;
            }
            continue;
        }

        if (arg.startsWith('--ask-for-approval=')) {
            const value = arg.slice('--ask-for-approval='.length);
            if (APPROVAL_POLICY_VALUES.has(value as CodexCliOverrides['approvalPolicy'])) {
                overrides.approvalPolicy = value as CodexCliOverrides['approvalPolicy'];
            }
        }
    }

    return overrides;
}

export function hasCodexCliOverrides(overrides?: CodexCliOverrides): boolean {
    return Boolean(overrides?.sandbox || overrides?.approvalPolicy || overrides?.serviceTier);
}
