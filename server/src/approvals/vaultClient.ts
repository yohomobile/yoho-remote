// Minimal HTTP client for the yoho-vault (yoho-memory) HTTP API.
// Used by the skill approval domain to list candidate skills + drive
// promote/archive/delete from yoho-remote.
//
// We deliberately keep this client tiny and dependency-free:
//   - reads URL + bearer token from env once at construction
//   - throws on non-2xx (caller decides whether to surface as effectsError)
//   - never retries (caller maps errors into approval workflow)

export type VaultSkillStatus = 'active' | 'candidate' | 'deprecated' | 'archived' | 'all'

export interface VaultSkillSummary {
    id: string
    name: string
    description: string
    category: string
    tags?: string[]
    status?: 'active' | 'candidate' | 'deprecated' | 'archived'
    activationMode?: 'manual' | 'model' | 'disabled'
    requiredTools?: string[]
    allowedTools?: string[]
    paths?: string[]
    antiTriggers?: string[]
}

export interface VaultSkillFull extends VaultSkillSummary {
    content: string
    usageCount: number
    lastUsed: string | null
}

export interface VaultMutationResult {
    id: string
    filePath: string
    status: string
    active: boolean
    targetId?: string
    deleted?: boolean
    message: string
}

interface VaultEnvelope<T> {
    result?: T
    error?: string
}

export interface VaultClientOptions {
    baseUrl: string
    token: string
    timeoutMs?: number
}

export class VaultClient {
    private readonly baseUrl: string
    private readonly token: string
    private readonly timeoutMs: number

    constructor(opts: VaultClientOptions) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
        this.token = opts.token
        this.timeoutMs = opts.timeoutMs ?? 5000
    }

    listSkills(args: {
        status?: VaultSkillStatus
        category?: string
        path?: string
        query?: string
    } = {}): Promise<{ skills: VaultSkillSummary[]; categories: string[]; count: number }> {
        return this.post('/api/skill_list', args)
    }

    getSkill(id: string): Promise<VaultSkillFull> {
        return this.post('/api/skill_get', { id })
    }

    promoteSkill(id: string): Promise<VaultMutationResult> {
        return this.post('/api/skill_promote', { id })
    }

    archiveSkill(id: string): Promise<VaultMutationResult> {
        return this.post('/api/skill_archive', { id })
    }

    deleteSkill(id: string, allowActive = false): Promise<VaultMutationResult> {
        return this.post('/api/skill_delete', { id, allowActive })
    }

    private async post<T>(path: string, body: unknown): Promise<T> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (this.token) headers.Authorization = `Bearer ${this.token}`
        const res = await fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body ?? {}),
            signal: AbortSignal.timeout(this.timeoutMs),
        })
        const text = await res.text().catch(() => '')
        if (!res.ok) {
            throw new Error(`vault ${path} failed: HTTP ${res.status}${text ? ` · ${text.slice(0, 300)}` : ''}`)
        }
        let json: VaultEnvelope<T>
        try {
            json = text ? (JSON.parse(text) as VaultEnvelope<T>) : {}
        } catch {
            throw new Error(`vault ${path} returned non-JSON: ${text.slice(0, 200)}`)
        }
        if (json.error) {
            throw new Error(`vault ${path} error: ${json.error}`)
        }
        if (json.result === undefined) {
            throw new Error(`vault ${path} returned envelope without result`)
        }
        return json.result
    }
}

let cached: VaultClient | null | undefined

/** Get a process-singleton VaultClient if env is configured, else null. */
export function getVaultClient(): VaultClient | null {
    if (cached !== undefined) return cached
    const baseUrl = process.env.YOHO_MEMORY_URL?.trim() || ''
    const token = process.env.YOHO_MEMORY_HTTP_AUTH_TOKEN?.trim() || ''
    if (!baseUrl || !token) {
        cached = null
        return null
    }
    cached = new VaultClient({
        baseUrl,
        token,
        timeoutMs: Number(process.env.YOHO_MEMORY_REQUEST_TIMEOUT_MS) || 5000,
    })
    return cached
}
