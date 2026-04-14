/**
 * Brain MCP Tools
 *
 * Provides session orchestration tools for Brain mode.
 * Brain sessions can create, control, and monitor other yoho-remote sessions.
 *
 * Uses true async callback: session_send returns immediately,
 * and the server pushes results back to the Brain session when
 * the child session completes (via sendBrainCallbackIfNeeded in syncEngine).
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ApiClient } from '@/api/api'
import { logger } from '@/ui/logger'
import {
    BRAIN_CLAUDE_CHILD_MODELS,
    BRAIN_CODEX_CHILD_MODELS,
    getAllowedBrainChildAgents,
    type BrainChildAgent,
    type BrainSessionPreferences,
} from '@/utils/brainSessionPreferences'

/** Context window budget by model mode (matches web/src/chat/modelConfig.ts) */
function getContextBudget(modelMode?: string): number {
    const HEADROOM = 10_000
    const windows: Record<string, number> = {
        default: 1_000_000,
        sonnet: 1_000_000,
        opus: 1_000_000,
        'gpt-5.4': 1_047_576,
        'gpt-5.4-mini': 1_047_576,
        'gpt-5.3-codex': 524_288,
        'gpt-5.3-codex-spark': 524_288,
    }
    return (windows[modelMode ?? 'default'] ?? 1_000_000) - HEADROOM
}

interface BrainToolsOptions {
    apiClient: ApiClient
    machineId: string
    brainSessionId: string
    brainPreferences?: BrainSessionPreferences | null
}

export function registerBrainTools(
    mcp: McpServer,
    toolNames: string[],
    options: BrainToolsOptions
): void {
    const { apiClient: api, machineId, brainSessionId } = options
    const brainPreferences = options.brainPreferences ?? null
    const allowedChildAgents = getAllowedBrainChildAgents(brainPreferences)
    const defaultChildAgent: BrainChildAgent = allowedChildAgents.includes('claude')
        ? 'claude'
        : (allowedChildAgents[0] ?? 'claude')
    const allowedClaudeModels = brainPreferences
        ? [...brainPreferences.childModels.claude.allowed]
        : [...BRAIN_CLAUDE_CHILD_MODELS]
    const allowedCodexModels = brainPreferences
        ? [...brainPreferences.childModels.codex.allowed]
        : [...BRAIN_CODEX_CHILD_MODELS]
    const defaultClaudeModel = brainPreferences?.childModels.claude.defaultModel ?? 'sonnet'
    const defaultCodexModel = brainPreferences?.childModels.codex.defaultModel ?? 'gpt-5.4'

    const describeAllowedValues = (values: readonly string[]): string =>
        values.length > 0 ? values.join(' / ') : '无'

    const childCapabilityGuide = [
        '当前 Brain 的子任务能力边界：',
        `- 默认子 session 机器：当前 Brain 所在机器${brainPreferences?.machineSelection.mode === 'manual' ? '（手动固定）' : '（自动选择）'}`,
        `- 可用子 session agent：${describeAllowedValues(allowedChildAgents)}`,
        `- Claude 子任务模型：${describeAllowedValues(allowedClaudeModels)}${allowedClaudeModels.length > 0 ? `；默认 ${defaultClaudeModel}` : ''}`,
        `- Codex 子任务模型：${describeAllowedValues(allowedCodexModels)}${allowedCodexModels.length > 0 ? `；默认 ${defaultCodexModel}` : ''}`,
    ].join('\n')

    const normalizeCodexModel = (value?: string): string | undefined => {
        const trimmed = value?.trim()
        if (!trimmed) return undefined
        return trimmed.replace(/^openai\//, '')
    }
    const defaultMachineId = brainPreferences?.machineSelection.machineId ?? machineId

    const resolveChildAgent = (value?: string): BrainChildAgent => {
        if (allowedChildAgents.length === 0) {
            throw new Error('当前 Brain 未开放任何子 session agent，请先在 Brain 配置中启用至少一个子任务模型。')
        }
        const trimmed = value?.trim()
        if (!trimmed) {
            return defaultChildAgent
        }
        if (trimmed !== 'claude' && trimmed !== 'codex') {
            throw new Error(`不支持的 agent "${trimmed}"。允许值：${describeAllowedValues(allowedChildAgents)}`)
        }
        if (!allowedChildAgents.includes(trimmed)) {
            throw new Error(`当前 Brain 不允许使用 agent "${trimmed}"。允许值：${describeAllowedValues(allowedChildAgents)}`)
        }
        return trimmed
    }

    const resolveClaudeModel = (value?: string): string => {
        if (allowedClaudeModels.length === 0) {
            throw new Error('当前 Brain 未开放 Claude 子 session。')
        }
        const trimmed = value?.trim()
        if (!trimmed || trimmed === 'default') {
            return defaultClaudeModel
        }
        if (!allowedClaudeModels.includes(trimmed as typeof allowedClaudeModels[number])) {
            throw new Error(`当前 Brain 不允许 Claude 模型 "${trimmed}"。允许值：${describeAllowedValues(allowedClaudeModels)}`)
        }
        return trimmed
    }

    const resolveCodexModel = (value?: string): string => {
        if (allowedCodexModels.length === 0) {
            throw new Error('当前 Brain 未开放 Codex 子 session。')
        }
        const normalized = normalizeCodexModel(value)
        if (!normalized) {
            return defaultCodexModel
        }
        if (!allowedCodexModels.includes(normalized as typeof allowedCodexModels[number])) {
            throw new Error(`当前 Brain 不允许 Codex 模型 "${normalized}"。允许值：${describeAllowedValues(allowedCodexModels)}`)
        }
        return normalized
    }

    const MODEL_SELECTION_GUIDE = [
        childCapabilityGuide,
        '',
        '使用规则：',
        `- 默认子 session agent：${defaultChildAgent}`,
        `- 不显式传 machineId 时，默认在机器 ${defaultMachineId.slice(0, 8)} 上创建或复用子 session`,
        '- 不要请求白名单外的 agent 或模型；运行时会直接拒绝。',
    ].join('\n')

    // ===== Helper: wait for session to come online AND finish its init prompt =====
    // Uses getSessionStatus.initDone — a server-side flag set when the first thinking→false
    // transition fires (i.e., init prompt completed). This is authoritative: no heuristics,
    // no debounce, immune to rate_limit_event pauses that briefly flip thinking=false.
    async function waitForSessionOnline(sessionId: string, timeoutSec = 120): Promise<boolean> {
        const deadline = Date.now() + timeoutSec * 1000

        // Phase 1: wait for active=true
        while (Date.now() < deadline) {
            try {
                const status = await api.getSessionStatus(sessionId)
                if (status.active) break
            } catch { /* not ready yet */ }
            await new Promise(r => setTimeout(r, 500))
        }
        if (Date.now() >= deadline) return false

        // Phase 2: wait for initDone=true (server sets this when init prompt completes)
        while (Date.now() < deadline) {
            try {
                const status = await api.getSessionStatus(sessionId)
                if (status.initDone) return true
            } catch { /* ignore */ }
            await new Promise(r => setTimeout(r, 500))
        }
        return false
    }

    type MachineCandidate = { id: string; displayName: string }

    // ===== Helper: resolve machine + agent =====
    // Child sessions are pinned to the Brain session's configured default machine unless
    // the Brain explicitly overrides machineId. Agent/model must stay within the
    // session-level white list captured in brainPreferences.
    async function resolveMachineAndAgent(
        requestedMachineId: string | undefined,
        requestedAgent: string | undefined,
        requestedModelMode?: string,
        requestedCodexModel?: string,
    ): Promise<{
        machineId: string
        agent: BrainChildAgent
        modelMode?: string
        codexModel?: string
        candidateMachineIds: Set<string>
        orderedCandidates: MachineCandidate[]
        fallbackNotice: string | null
    }> {
        const agent = resolveChildAgent(requestedAgent)
        const modelMode = agent === 'claude' ? resolveClaudeModel(requestedModelMode) : undefined
        const codexModel = agent === 'codex' ? resolveCodexModel(requestedCodexModel) : undefined
        const defaultId = requestedMachineId?.trim() || defaultMachineId
        const fallback = {
            machineId: defaultId,
            agent,
            modelMode,
            codexModel,
            candidateMachineIds: new Set([defaultId]),
            orderedCandidates: [{ id: defaultId, displayName: defaultId.slice(0, 8) }],
            fallbackNotice: null as string | null,
        }

        try {
            const allMachines = await api.listMachines()
            const online = allMachines.filter(m => m.active)
            const displayOf = (m: (typeof online)[number]): string =>
                (m.metadata?.displayName || m.metadata?.host || m.id.slice(0, 8)) as string

            const candidates = online.filter(m => m.id === defaultId)
            if (candidates.length === 0) {
                return fallback
            }

            const pick = candidates[0]
            const supportedAgents = pick?.supportedAgents ?? null
            if (supportedAgents && supportedAgents.length > 0 && !supportedAgents.includes(agent)) {
                throw new Error(`机器 "${displayOf(pick)}" 不支持 agent "${agent}"。支持：${supportedAgents.join(', ')}`)
            }

            return {
                machineId: pick.id,
                agent,
                modelMode,
                codexModel,
                candidateMachineIds: new Set([pick.id]),
                orderedCandidates: [{ id: pick.id, displayName: displayOf(pick) }],
                fallbackNotice: null,
            }
        } catch (error) {
            if (error instanceof Error && error.message) {
                throw error
            }
            return fallback
        }
    }

    // ===== Helper: spawn with machine fallback =====
    // Tries each candidate machine in order until one succeeds.
    // Returns the result plus a log of skipped machines (for transparency to Brain).
    async function spawnWithFallback(opts: {
        orderedCandidates: MachineCandidate[]
        agent: string
        modelMode?: string
        codexModel?: string
        directory: string
    }): Promise<{
        type: 'success'
        sessionId: string
        machineId: string
        skippedLog: string[]
    } | {
        type: 'error'
        message: string
        skippedLog: string[]
    }> {
        const skippedLog: string[] = []

        if (opts.orderedCandidates.length === 0) {
            return { type: 'error', message: '没有可用的候选机器', skippedLog }
        }

        for (const candidate of opts.orderedCandidates) {
            try {
                const result = await api.brainSpawnSession({
                    machineId: candidate.id,
                    directory: opts.directory,
                    agent: opts.agent,
                    modelMode: opts.modelMode,
                    codexModel: opts.codexModel,
                    source: 'brain-child',
                    mainSessionId: brainSessionId,
                })
                if (result.type === 'success') {
                    return { type: 'success', sessionId: result.sessionId, machineId: candidate.id, skippedLog }
                }
                skippedLog.push(`${candidate.displayName}: ${result.message}`)
            } catch (err: any) {
                skippedLog.push(`${candidate.displayName}: ${err.message || String(err)}`)
            }
        }

        const tried = opts.orderedCandidates.map(c => c.displayName).join(', ')
        return { type: 'error', message: `所有机器均失败（已尝试: ${tried}）`, skippedLog }
    }

    // ===== 1. session_create =====
    const createSchema: z.ZodTypeAny = z.object({
        directory: z.string().describe('工作目录的绝对路径，如 /home/guang/softwares/yoho-remote'),
        machineId: z.string().optional().describe(`目标机器 ID。不填时默认使用当前 Brain 的默认机器（${defaultMachineId.slice(0, 8)}）。`),
        agent: z.string().optional().describe(`子 session agent。允许值：${describeAllowedValues(allowedChildAgents)}；默认 ${defaultChildAgent}。`),
        modelMode: z.string().optional().describe(`Claude 模型（agent=claude 时生效）。允许值：${describeAllowedValues(allowedClaudeModels)}；默认 ${defaultClaudeModel}。`),
        codexModel: z.string().optional().describe(`Codex 模型（agent=codex 时生效）。允许值：${describeAllowedValues(allowedCodexModels)}；默认 ${defaultCodexModel}。`),
    })

    mcp.registerTool<any, any>('session_create', {
        title: 'Create Session',
        description: `强制创建新的工作 session。如果只想发任务到已有目录，优先使用 session_find_or_create 来复用空闲 session。\n\n${MODEL_SELECTION_GUIDE}`,
        inputSchema: createSchema,
    }, async (args: { directory: string; machineId?: string; agent?: string; modelMode?: string; codexModel?: string }) => {
        try {
            const resolved = await resolveMachineAndAgent(args.machineId, args.agent, args.modelMode, args.codexModel)
            logger.debug(`[brain] Creating session: machine=${resolved.machineId}, dir=${args.directory}, agent=${resolved.agent}`)

            const spawnResult = await spawnWithFallback({
                orderedCandidates: resolved.orderedCandidates,
                agent: resolved.agent,
                modelMode: resolved.modelMode,
                codexModel: resolved.codexModel,
                directory: args.directory,
            })

            if (spawnResult.type === 'success') {
                const ready = await waitForSessionOnline(spawnResult.sessionId)
                const machineNote = spawnResult.machineId !== defaultMachineId
                    ? `\n机器: ${spawnResult.machineId.slice(0, 8)}`
                    : ''
                const skipNote = spawnResult.skippedLog.length > 0
                    ? `\n⚠️ 已跳过 ${spawnResult.skippedLog.length} 台失败机器:\n${spawnResult.skippedLog.map(s => `  - ${s}`).join('\n')}`
                    : ''
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session 创建成功。\n\nsessionId: ${spawnResult.sessionId}\n状态: ${ready ? '已上线' : '启动中（可能需要等待几秒）'}${machineNote}${skipNote}`,
                    }],
                }
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: `创建失败: ${spawnResult.message}${spawnResult.skippedLog.length > 0 ? `\n\n失败详情:\n${spawnResult.skippedLog.map(s => `  - ${s}`).join('\n')}` : ''}`,
                }],
                isError: true,
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `创建失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    })

    // ===== 2. session_find_or_create =====
    const findOrCreateSchema: z.ZodTypeAny = z.object({
        directory: z.string().describe('工作目录的绝对路径'),
        hint: z.string().optional().describe('任务意图关键词（如 "订单API 优惠券"），用于匹配已有上下文的 session，优先复用做过相关工作的 session，省去重新理解代码的成本'),
        machineId: z.string().optional().describe(`目标机器 ID。不填时只在默认机器 ${defaultMachineId.slice(0, 8)} 上查找或创建子 session。`),
        agent: z.string().optional().describe(`子 session agent。允许值：${describeAllowedValues(allowedChildAgents)}；默认 ${defaultChildAgent}。`),
        modelMode: z.string().optional().describe(`Claude 模型（agent=claude 时生效）。允许值：${describeAllowedValues(allowedClaudeModels)}；默认 ${defaultClaudeModel}。`),
        codexModel: z.string().optional().describe(`Codex 模型（agent=codex 时生效）。允许值：${describeAllowedValues(allowedCodexModels)}；默认 ${defaultCodexModel}。`),
    })

    mcp.registerTool<any, any>('session_find_or_create', {
        title: 'Find or Create Session',
        description: `智能查找可复用的空闲子 session。默认只在当前 Brain 的默认机器上搜索匹配 directory + 属于当前 Brain + agent 的空闲 session；显式传 machineId 时只搜索那台机器。找不到则在对应机器上创建新 session。推荐优先使用此工具。\n\n${MODEL_SELECTION_GUIDE}\n\n复用逻辑：优先匹配相同 agent + modelMode 的 session。`,
        inputSchema: findOrCreateSchema,
    }, async (args: { directory: string; hint?: string; machineId?: string; agent?: string; modelMode?: string; codexModel?: string }) => {
        try {
            const resolved = await resolveMachineAndAgent(args.machineId, args.agent, args.modelMode, args.codexModel)
            const { candidateMachineIds } = resolved

            // Step 1: List online sessions
            const data = await api.listSessions({ includeOffline: false })

            // Step 2: Find reusable child session on the selected machine
            const candidates = data.sessions.filter(s => {
                if (!s.metadata) return false
                if (s.metadata.source !== 'brain-child') return false
                if (s.metadata.mainSessionId !== brainSessionId) return false
                if (s.metadata.path !== args.directory) return false
                if (!s.metadata.machineId || !candidateMachineIds.has(s.metadata.machineId)) return false
                if (!s.active) return false
                if (s.thinking) return false
                if (s.pendingRequestsCount > 0) return false
                const sessionFlavor = s.metadata.flavor || 'claude'
                if (sessionFlavor !== resolved.agent) return false
                return true
            })

            // Pick the best candidate: prefer model match, then context-relevant (hint matches brainSummary), then most recently active
            if (candidates.length > 0) {
                let best = candidates.sort((a, b) => b.activeAt - a.activeAt)[0]
                let matchReason = '最近活跃'

                const normalizeModel = (mode?: string) => {
                    if (!mode || mode === 'default') return 'sonnet'
                    return mode
                }
                const targetModel = resolved.agent === 'codex'
                    ? (resolved.codexModel || 'gpt-5.4')
                    : (resolved.modelMode || defaultClaudeModel)
                const exactModelMatches = candidates.filter(s => {
                    return normalizeModel(s.modelMode) === normalizeModel(targetModel)
                })
                const candidatesForHint = exactModelMatches.length > 0 ? exactModelMatches : candidates

                if (exactModelMatches.length > 0 && exactModelMatches.length < candidates.length) {
                    best = exactModelMatches.sort((a, b) => b.activeAt - a.activeAt)[0]
                    matchReason = `模型匹配 (${targetModel})`
                }

                // Step 2: If hint provided, prefer context match within modelMode-filtered candidates
                if (args.hint && candidatesForHint.length > 1) {
                    const hintKeywords = args.hint.toLowerCase().split(/[\s,，/]+/).filter(k => k.length > 0)
                    if (hintKeywords.length > 0) {
                        const scored = candidatesForHint.map(s => {
                            const text = [
                                s.metadata?.brainSummary || '',
                                s.metadata?.summary?.text || '',
                            ].join(' ').toLowerCase()
                            const hits = hintKeywords.filter(k => text.includes(k)).length
                            return { session: s, hits }
                        })
                        const topMatch = scored.sort((a, b) =>
                            b.hits - a.hits || b.session.activeAt - a.session.activeAt
                        )[0]
                        if (topMatch.hits > 0) {
                            best = topMatch.session
                            matchReason = `模型+上下文匹配 (${targetModel}, ${topMatch.hits}/${hintKeywords.length} 关键词)`
                        }
                    }
                }

                const title = best.metadata?.summary?.text || best.metadata?.brainSummary || '未命名'
                const summary = best.metadata?.brainSummary ? `\n上次总结: ${best.metadata.brainSummary}` : ''
                const sessionMachineId = best.metadata?.machineId
                const machineNote = sessionMachineId && sessionMachineId !== defaultMachineId
                    ? `\n机器: ${sessionMachineId.slice(0, 8)}`
                    : ''
                return {
                    content: [{
                        type: 'text' as const,
                        text: `复用已有 Session。\n\nsessionId: ${best.id}\n标题: ${title}\n匹配: ${matchReason}${machineNote}${summary}\n状态: ✅ 空闲`,
                    }],
                }
            }

            // Step 3: No reusable session — create on the best resolved machine (with fallback)
            logger.debug(`[brain] No reusable session for dir=${args.directory}, agent=${resolved.agent}, machine=${resolved.machineId}`)

            const spawnResult = await spawnWithFallback({
                orderedCandidates: resolved.orderedCandidates,
                agent: resolved.agent,
                modelMode: resolved.modelMode,
                codexModel: resolved.codexModel,
                directory: args.directory,
            })

            if (spawnResult.type === 'success') {
                const ready = await waitForSessionOnline(spawnResult.sessionId)
                const machineNote = spawnResult.machineId !== defaultMachineId
                    ? `\n机器: ${spawnResult.machineId.slice(0, 8)}`
                    : ''
                const skipNote = spawnResult.skippedLog.length > 0
                    ? `\n⚠️ 已跳过 ${spawnResult.skippedLog.length} 台失败机器:\n${spawnResult.skippedLog.map(s => `  - ${s}`).join('\n')}`
                    : ''
                return {
                    content: [{
                        type: 'text' as const,
                        text: `无可复用 session，已创建新 session。\n\nsessionId: ${spawnResult.sessionId}\n状态: ${ready ? '已上线' : '启动中（可能需要等待几秒）'}${machineNote}${skipNote}`,
                    }],
                }
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: `创建失败: ${spawnResult.message}${spawnResult.skippedLog.length > 0 ? `\n\n失败详情:\n${spawnResult.skippedLog.map(s => `  - ${s}`).join('\n')}` : ''}`,
                }],
                isError: true,
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `查找/创建失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    })

    // ===== 3. session_send (async, non-blocking) =====
    const sendSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('目标 session ID'),
        message: z.string().describe('要发送的消息/任务指令'),
    })

    mcp.registerTool<any, any>('session_send', {
        title: 'Send to Session',
        description: '向指定 session 发送消息/任务。非阻塞：立即返回，子 session 完成后结果会自动推送到你的对话中。你可以继续处理其他任务。',
        inputSchema: sendSchema,
    }, async (args: { sessionId: string; message: string }) => {
        try {
            // Check if session is thinking first
            let session
            try {
                session = await api.getSession(args.sessionId)
            } catch (err: any) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session ${args.sessionId} 未找到或无法访问: ${err.message}`,
                    }],
                    isError: true,
                }
            }

            if (session.thinking) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session ${args.sessionId} 正在处理上一个任务（thinking=true）。请稍后再发送。`,
                    }],
                }
            }

            if (!session.active) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session ${args.sessionId} 当前不在线（active=false）。请创建新 session 或等待其重新上线。`,
                    }],
                }
            }

            // Send message - fire and forget
            await api.sendMessageToSession(args.sessionId, args.message, 'brain')

            logger.debug(`[brain] Message sent to session ${args.sessionId}, returning immediately (async callback mode)`)

            return {
                content: [{
                    type: 'text' as const,
                    text: `任务已发送到 Session ${args.sessionId}。\n\n子 session 正在后台执行，完成后结果会自动推送到你的对话中。你可以继续处理其他任务。`,
                }],
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `发送失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    })

    // ===== 4. session_list =====
    const listSchema: z.ZodTypeAny = z.object({
        includeOffline: z.boolean().optional().describe('是否包含离线 session，默认 false（只返回在线的）'),
    })

    mcp.registerTool<any, any>('session_list', {
        title: 'List Sessions',
        description: '列出 session 及其状态。默认只返回在线 session，传 includeOffline=true 可包含离线 session。',
        inputSchema: listSchema,
    }, async (args: { includeOffline?: boolean }) => {
        try {
            const data = await api.listSessions({ includeOffline: args.includeOffline })
            if (!data.sessions || data.sessions.length === 0) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: '当前没有任何 session。',
                    }],
                }
            }

            const lines = data.sessions.map(s => {
                const status = !s.active
                    ? '⬜ 离线'
                    : s.thinking
                        ? '🔄 执行中'
                        : '✅ 空闲'
                const name = s.metadata?.summary?.text || s.metadata?.path || '未命名'
                const source = s.metadata?.source ? ` [${s.metadata.source}]` : ''
                const isMine = s.metadata?.mainSessionId === brainSessionId ? ' 📌' : ''
                const flavor = s.metadata?.flavor ? `${s.metadata.flavor}` : 'claude'
                const model = s.modelMode && s.modelMode !== 'default' ? `/${s.modelMode}` : ''
                const agentLabel = ` [${flavor}${model}]`
                const summary = s.metadata?.brainSummary ? `\n  总结: ${s.metadata.brainSummary}` : ''
                return `- ${s.id.slice(0, 8)} [${status}]${agentLabel} ${name}${source}${isMine}${summary}`
            })

            return {
                content: [{
                    type: 'text' as const,
                    text: `当前 sessions (${data.sessions.length}):\n${lines.join('\n')}`,
                }],
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `列出失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    })

    // ===== 5. session_close =====
    const closeSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('要关闭的 session ID'),
    })

    mcp.registerTool<any, any>('session_close', {
        title: 'Close Session',
        description: '关闭指定 session。',
        inputSchema: closeSchema,
    }, async (args: { sessionId: string }) => {
        try {
            const result = await api.deleteSession(args.sessionId)
            if (result.ok) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session ${args.sessionId} 已关闭。`,
                    }],
                }
            }
            return {
                content: [{
                    type: 'text' as const,
                    text: `关闭失败: 操作未成功。`,
                }],
                isError: true,
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `关闭失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    })

    // ===== 6. session_update =====
    const updateSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('目标 session ID'),
        brainSummary: z.string().describe('Brain 写入的任务总结（持久化到 session metadata）'),
    })

    mcp.registerTool<any, any>('session_update', {
        title: 'Update Session',
        description: '更新子 session 的元信息。用于写入 brainSummary（任务总结），方便后续复用时识别 session 做过什么。',
        inputSchema: updateSchema,
    }, async (args: { sessionId: string; brainSummary: string }) => {
        try {
            await api.patchSessionMetadata(args.sessionId, {
                brainSummary: args.brainSummary,
            })
            return {
                content: [{
                    type: 'text' as const,
                    text: `已更新 Session ${args.sessionId} 的总结。`,
                }],
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `更新失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    })

    // ===== 7. session_status =====
    const statusSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('要查询的 session ID'),
    })

    mcp.registerTool<any, any>('session_status', {
        title: 'Session Status',
        description: '查询 session 的详细状态：在线/执行中/消息数/token 用量/context 使用率。用于判断是否需要 compact。',
        inputSchema: statusSchema,
    }, async (args: { sessionId: string }) => {
        try {
            const status = await api.getSessionStatus(args.sessionId)

            const lines = [
                `Session: ${args.sessionId}`,
                `状态: ${!status.active ? '离线' : status.thinking ? '执行中' : '空闲'}`,
                `消息数: ${status.messageCount}`,
            ]

            if (status.metadata?.brainSummary) {
                lines.push(`总结: ${status.metadata.brainSummary}`)
            }

            if (status.lastUsage) {
                const contextBudget = getContextBudget(status.modelMode)
                const contextSize = status.lastUsage.contextSize ?? status.lastUsage.input_tokens
                const remainingPercent = Math.max(0, Math.round((1 - contextSize / contextBudget) * 100))
                lines.push(`Context 剩余: ~${remainingPercent}% (${contextSize.toLocaleString()} / ${contextBudget.toLocaleString()} tokens)`)

                if (remainingPercent <= 20) {
                    lines.push(`⚠️ Context 剩余不足，建议发送 /compact 命令`)
                }
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: lines.join('\n'),
                }],
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `查询失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    })

    // ===== 8. session_set_model_mode =====
    const setModelModeSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('目标 session ID'),
        modelMode: z.enum(['default', 'sonnet', 'opus']).describe('要切换到的模型。sonnet 适合日常任务，opus 适合复杂推理任务。'),
    })

    mcp.registerTool<any, any>('session_set_model_mode', {
        title: 'Set Session Model Mode',
        description: '切换指定 session 的模型。适用场景：当任务复杂度发生变化时，可以从 sonnet 切换到 opus（或反之）。注意：切换模型不会影响已有的对话历史，但会影响后续的推理能力和成本。',
        inputSchema: setModelModeSchema,
    }, async (args: { sessionId: string; modelMode: string }) => {
        try {
            await api.setSessionModelMode(args.sessionId, args.modelMode as any)
            return {
                content: [{
                    type: 'text' as const,
                    text: `已将 Session ${args.sessionId} 的模型切换为 ${args.modelMode}。`,
                }],
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `切换模型失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    })

    // ===== 9. chat_messages =====
    const chatMessagesSchema: z.ZodTypeAny = z.object({
        chatId: z.string().describe('飞书 chat_id（群聊或单聊）'),
        limit: z.number().optional().describe('返回条数，默认 50，最大 200'),
        beforeTimestamp: z.number().optional().describe('只返回此时间戳之前的消息（毫秒），用于翻页'),
    })

    mcp.registerTool<any, any>('chat_messages', {
        title: 'Chat Messages',
        description: '查询飞书聊天的历史消息记录（单聊或群聊）。返回持久化的消息列表，按时间倒序。可用于了解对话上下文、查找之前讨论的内容。',
        inputSchema: chatMessagesSchema,
    }, async (args: { chatId: string; limit?: number; beforeTimestamp?: number }) => {
        try {
            const limit = Math.min(args.limit || 50, 200)
            const messages = await api.getFeishuChatMessages(args.chatId, limit, args.beforeTimestamp)

            if (messages.length === 0) {
                return {
                    content: [{ type: 'text' as const, text: '没有找到消息记录。' }],
                }
            }

            const lines = messages.reverse().map((m: any) =>
                `[${new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}] ${m.senderName}: ${m.content}`
            )
            return {
                content: [{
                    type: 'text' as const,
                    text: `共 ${messages.length} 条消息：\n${lines.join('\n')}`,
                }],
            }
        } catch (err: any) {
            return {
                content: [{ type: 'text' as const, text: `查询失败: ${err.message || String(err)}` }],
                isError: true,
            }
        }
    })

    toolNames.push(
        'session_create',
        'session_find_or_create',
        'session_send',
        'session_list',
        'session_close',
        'session_update',
        'session_status',
        'session_set_model_mode',
        'chat_messages',
    )

    logger.debug(`[brain] Registered 9 brain tools (async mode) for session ${brainSessionId}`)
}
