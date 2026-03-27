import { ApiClient } from '@/api/api'
import type { ClaudeAccount } from '@/api/types'
import { logger } from '@/ui/logger'
import { ensureClaudeSessionSymlink } from '@/claude/utils/sessionSymlink'

/** Patterns indicating the account is exhausted/unauthorized */
const ACCOUNT_EXHAUSTION_PATTERNS = [
    /\b401\b/,
    /unauthorized/i,
    /authentication.*failed/i,
    /does not have access/i,
    /token.*exhaust/i,
    /rate.*limit/i,
    /quota.*exceeded/i,
    /over.?capacity/i,
]

export function isAccountExhaustedError(errorMessage: string): boolean {
    return ACCOUNT_EXHAUSTION_PATTERNS.some(p => p.test(errorMessage))
}

export interface AccountRotationResult {
    success: boolean
    newAccount?: ClaudeAccount
    reason: string
}

/**
 * Select a new account, create symlinks for session continuity,
 * and return the new account info.
 */
export async function rotateAccount(opts: {
    api: ApiClient
    currentConfigDir?: string
    claudeSessionId: string | null
    workingDirectory: string
}): Promise<AccountRotationResult> {
    const newAccount = await opts.api.selectBestClaudeAccount(opts.currentConfigDir)
    if (!newAccount) {
        return { success: false, reason: 'no_accounts_available' }
    }

    // Don't rotate to the same account (compare by configDir which is always available)
    if (opts.currentConfigDir && newAccount.configDir === opts.currentConfigDir) {
        return { success: false, reason: 'same_account_selected' }
    }

    // Create symlink for session file if we have a Claude session ID
    if (opts.claudeSessionId) {
        ensureClaudeSessionSymlink({
            sessionId: opts.claudeSessionId,
            newAccountConfigDir: newAccount.configDir,
            workingDirectory: opts.workingDirectory,
        })
    }

    return { success: true, newAccount, reason: 'rotated' }
}
