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
import { registerAskUserQuestionTool, registerChatMessagesTool } from './interactionTools'
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
    sessionCaller?: string | null
    brainPreferences?: BrainSessionPreferences | null
}

export function buildBrainCreateDescription(modelSelectionGuide: string): string {
    return `强制创建新的工作 session。仅在确实需要真正并行或上下文隔离时使用；如果目标是延续同一任务线，优先使用 session_find_or_create 来复用空闲 session。碰到需要判断、定位、方案选择、复杂问题时，可以把它作为第二路或更多独立调研/验证的一路；但简单明确任务不要为了凑两路机械双开。\n\n${modelSelectionGuide}`
}

export function buildBrainFindOrCreateDescription(modelSelectionGuide: string): string {
    return `智能查找可复用的空闲子 session。默认只在当前 Brain 的默认机器上搜索匹配 directory + 属于当前 Brain + agent 的空闲 session；显式传 machineId 时只搜索那台机器。若 hint 命中历史总结/标题，会优先复用或恢复真正做过相关分析的旧 session；只有找不到合适上下文时才创建新 session。这是默认入口。\n\n${modelSelectionGuide}\n\n复用逻辑：优先匹配相同 agent + modelMode 的 session，把同一任务线持续交给同一个 session；只有需要真正并行或上下文隔离时，才退回到 session_create。碰到需要判断、定位、方案选择、复杂问题时，默认至少组织两路独立调研/验证后再汇总决策；简单明确任务不要机械双开。`
}

export const BRAIN_SESSION_SEND_DESCRIPTION = '向指定 session 发送消息/任务。非阻塞：立即返回，子 session 完成后结果会自动推送到你的对话中。发送后默认结束当前轮，不要为了等结果轮询 session_list/session_status；只有超时排障、/compact 判断、监督分工进度、或需要重调度/纠偏时才查状态。'
export const BRAIN_SESSION_LIST_DESCRIPTION = '仅列出当前 Brain 下面的子 session 及其状态。用于盘点分工、复用选择、监督哪些子 session 正在做什么、重调度和排障；不要把它当成等待结果的轮询循环。默认只返回在线 session，传 includeOffline=true 可包含离线 session。'
export const BRAIN_SESSION_ABORT_DESCRIPTION = '停止指定 session 当前正在执行的任务，但保留 session 本身。仅在用户明确要求停掉旧任务/切换方向、子 session 已明显跑偏、或必须立即纠偏时使用；不要因为普通补充信息、追问一句、或新增一个可并行任务就 stop 正常运行的 session。需要纠偏时，先用它 stop 旧任务，再 session_send 新任务。'
export const BRAIN_SESSION_STOP_DESCRIPTION = '中止指定 session 当前正在执行的任务，但保留 session 本身。只有在旧任务已不该继续、子 session 明显跑偏、或需要立刻切换方向时才用它；正常并行任务默认继续跑，不要轻易 stop。这是 Brain 正式使用的 stop 能力；不要用 session_close 代替 stop。'
export const BRAIN_SESSION_RESUME_DESCRIPTION = '恢复一个已离线/已归档但上下文仍值得复用的 session。恢复成功后可继续 session_send；如果底层恢复时回退创建了新 session，会返回新的 sessionId，后续必须改用新的 sessionId。'
export const BRAIN_SESSION_UPDATE_DESCRIPTION = '更新子 session 的元信息。子任务完成后必须写入一行 brainSummary（任务总结），方便后续复用时快速识别 session 做过什么。'
export const BRAIN_SESSION_STATUS_DESCRIPTION = '查询当前 Brain 某个子 session 的详细状态：在线/执行中/消息数/token 用量/context 使用率。仅用于超时排障、/compact 判断、监督子 session 是否跑偏、或重调度/纠偏，不要持续轮询。'
export const BRAIN_SESSION_INSPECT_DESCRIPTION = '一次返回当前 Brain 某个子 session 的编排/排障快照：lastMessageAt、todoProgress、activeMonitors、terminationReason、runtimeModel、fastMode、pendingRequests、context 信息等。用于判断卡在哪、是否要 stop/纠偏/重调度；不要持续轮询。'
export const BRAIN_SESSION_TAIL_DESCRIPTION = '查看当前 Brain 某个子 session 最近几条真实输出/事件片段（assistant/result/tool/todo/user turn 等），用于排障和调度判断。它返回的是最近的实际内容片段，不是 messageCount 这类弱摘要；不要持续轮询。'
export const BRAIN_SESSION_SET_CONFIG_DESCRIPTION = '统一调整子 session 的运行时 steering。优先用它设置 model / reasoningEffort / fastMode，以及当前架构支持的 permissionMode；新代码不要再拆成多个零散配置接口。'

export function registerBrainTools(
    mcp: McpServer,
    toolNames: string[],
    options: BrainToolsOptions
): void {
    const initialToolCount = toolNames.length
    const { apiClient: api, machineId, brainSessionId, sessionCaller } = options
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
    const childSessionScope = { mainSessionId: brainSessionId }

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
        `- 默认子 session agent：${defaultChildAgent}${allowedChildAgents.length > 1 ? '；如果目标机器不支持该默认值，会自动切换到当前 Brain 允许的其它 agent' : ''}`,
        `- 不显式传 machineId 时，默认在机器 ${defaultMachineId.slice(0, 8)} 上创建或复用子 session`,
        '- 不要请求白名单外的 agent 或模型；运行时会直接拒绝。',
    ].join('\n')

    // ===== Helper: wait for session to come online =====
    // Brain-child init may still be running after active=true. That's acceptable because
    // session_send from Brain is buffered server-side until init finishes.
    async function waitForSessionOnline(sessionId: string, timeoutSec = 120): Promise<boolean> {
        const deadline = Date.now() + timeoutSec * 1000
        let pollAttempt = 0
        const nextDelayMs = () => {
            const schedule = [100, 150, 250, 500]
            const index = Math.min(pollAttempt, schedule.length - 1)
            pollAttempt += 1
            return schedule[index]
        }

        while (Date.now() < deadline) {
            try {
                const status = await api.getSessionStatus(sessionId, childSessionScope)
                if (status.active) return true
            } catch { /* not ready yet */ }
            await new Promise(r => setTimeout(r, nextDelayMs()))
        }
        return false
    }

    type MachineCandidate = { id: string; displayName: string }

    // ===== Helper: resolve machine + agent =====
    // Child sessions are pinned to the Brain session's configured default machine unless
    // the Brain explicitly overrides machineId. Agent/model must stay within the
    // session-level white list captured in brainPreferences.
    function resolveModelSelection(
        agent: BrainChildAgent,
        requestedModelMode?: string,
        requestedCodexModel?: string,
    ): {
        modelMode?: string
        codexModel?: string
    } {
        return {
            modelMode: agent === 'claude' ? resolveClaudeModel(requestedModelMode) : undefined,
            codexModel: agent === 'codex' ? resolveCodexModel(requestedCodexModel) : undefined,
        }
    }

    function resolveDefaultAgentForMachine(supportedAgents: readonly string[] | null | undefined, machineLabel: string): BrainChildAgent {
        if (!supportedAgents || supportedAgents.length === 0) {
            return defaultChildAgent
        }

        if (supportedAgents.includes(defaultChildAgent)) {
            return defaultChildAgent
        }

        const fallbackAgent = allowedChildAgents.find((candidate) => supportedAgents.includes(candidate))
        if (fallbackAgent) {
            return fallbackAgent
        }

        throw new Error(`机器 "${machineLabel}" 不支持当前 Brain 允许的任何 agent。机器支持：${supportedAgents.join(', ')}；Brain 允许：${describeAllowedValues(allowedChildAgents)}`)
    }

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
        const explicitAgent = requestedAgent?.trim() ? resolveChildAgent(requestedAgent) : null
        const fallbackAgent = explicitAgent ?? defaultChildAgent
        const fallbackModelSelection = resolveModelSelection(fallbackAgent, requestedModelMode, requestedCodexModel)
        const defaultId = requestedMachineId?.trim() || defaultMachineId
        const fallback = {
            machineId: defaultId,
            agent: fallbackAgent,
            modelMode: fallbackModelSelection.modelMode,
            codexModel: fallbackModelSelection.codexModel,
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
            const pickDisplayName = displayOf(pick)
            const supportedAgents = pick?.supportedAgents ?? null
            const agent = explicitAgent ?? resolveDefaultAgentForMachine(supportedAgents, pickDisplayName)
            if (supportedAgents && supportedAgents.length > 0 && !supportedAgents.includes(agent)) {
                throw new Error(`机器 "${pickDisplayName}" 不支持 agent "${agent}"。支持：${supportedAgents.join(', ')}`)
            }
            const modelSelection = resolveModelSelection(agent, requestedModelMode, requestedCodexModel)

            return {
                machineId: pick.id,
                agent,
                modelMode: modelSelection.modelMode,
                codexModel: modelSelection.codexModel,
                candidateMachineIds: new Set([pick.id]),
                orderedCandidates: [{ id: pick.id, displayName: pickDisplayName }],
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
                    caller: sessionCaller ?? undefined,
                    brainPreferences: brainPreferences ?? undefined,
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

    type ListedBrainSession = Awaited<ReturnType<ApiClient['listSessions']>>['sessions'][number]
    type BrainSearchResult = Awaited<ReturnType<ApiClient['searchSessions']>>['results'][number]

    const normalizeReuseModel = (mode?: string | null): string => {
        if (!mode || mode === 'default') return 'sonnet'
        return mode
    }

    const buildHintSignals = (hint?: string): { normalizedHint: string; keywords: string[] } | null => {
        const normalizedHint = hint?.trim().toLowerCase() ?? ''
        if (!normalizedHint) {
            return null
        }
        const keywords = Array.from(new Set(
            normalizedHint
                .split(/[\s,，/]+/)
                .map((keyword) => keyword.trim())
                .filter((keyword) => keyword.length > 0)
        ))
        return {
            normalizedHint,
            keywords,
        }
    }

    const getSessionReuseText = (input: {
        brainSummary?: string | null
        title?: string | null
        path?: string | null
        matchText?: string | null
    }): string => {
        return [
            input.brainSummary ?? '',
            input.title ?? '',
            input.path ?? '',
            input.matchText ?? '',
        ].join(' ').toLowerCase()
    }

    const scoreHintCoverage = (text: string, hintSignals: { normalizedHint: string; keywords: string[] }) => {
        const exactPhrase = text.includes(hintSignals.normalizedHint)
        const keywordHits = hintSignals.keywords.filter((keyword) => text.includes(keyword)).length
        return {
            exactPhrase,
            keywordHits,
            keywordCount: hintSignals.keywords.length,
        }
    }

    const isStrongHintMatch = (coverage: { exactPhrase: boolean; keywordHits: number; keywordCount: number }): boolean => {
        if (coverage.exactPhrase) {
            return true
        }
        if (coverage.keywordCount <= 1) {
            return coverage.keywordHits >= 1
        }
        return coverage.keywordHits >= Math.min(2, coverage.keywordCount)
    }

    async function findHistoricalReusableSession(args: {
        directory: string
        hint?: string
        agent: BrainChildAgent
        targetModel: string
        candidateMachineIds: Set<string>
        activeCandidates: ListedBrainSession[]
    }): Promise<null | {
        searchResult: BrainSearchResult
        liveSession: ListedBrainSession | null
        matchReason: string
    }> {
        const hintSignals = buildHintSignals(args.hint)
        if (!hintSignals) {
            return null
        }

        const activeById = new Map(args.activeCandidates.map((session) => [session.id, session]))
        const search = await api.searchSessions({
            query: args.hint!.trim(),
            limit: 8,
            includeOffline: true,
            mainSessionId: brainSessionId,
            directory: args.directory,
            flavor: args.agent,
            source: 'brain-child',
        })

        const ranked = search.results
            .map((result) => {
                const metadata = result.metadata
                if (!metadata || metadata.source !== 'brain-child') return null
                if (metadata.mainSessionId !== brainSessionId) return null
                if (metadata.path !== args.directory) return null
                if (!metadata.machineId || !args.candidateMachineIds.has(metadata.machineId)) return null
                const sessionFlavor = metadata.flavor || 'claude'
                if (sessionFlavor !== args.agent) return null
                if (result.thinking || result.pendingRequestsCount > 0) return null

                const liveSession = activeById.get(result.sessionId) ?? null
                if (result.active && !liveSession) return null

                const coverage = scoreHintCoverage(getSessionReuseText({
                    brainSummary: metadata.brainSummary,
                    title: metadata.summary?.text,
                    path: metadata.path,
                    matchText: result.match.text,
                }), hintSignals)
                if (!isStrongHintMatch(coverage)) return null

                const sessionModel = liveSession?.modelMode ?? result.modelMode
                const modelMatch = normalizeReuseModel(sessionModel) === normalizeReuseModel(args.targetModel)
                const matchDetails = [
                    modelMatch ? `模型匹配 (${args.targetModel})` : null,
                    `历史${result.match.source}`,
                    coverage.exactPhrase
                        ? '整句命中'
                        : `${coverage.keywordHits}/${coverage.keywordCount} 关键词`,
                ].filter(Boolean).join(' + ')

                return {
                    searchResult: result,
                    liveSession,
                    modelMatch,
                    exactPhrase: coverage.exactPhrase,
                    keywordHits: coverage.keywordHits,
                    matchReason: matchDetails,
                }
            })
            .filter((item): item is NonNullable<typeof item> => Boolean(item))

        ranked.sort((a, b) =>
            Number(b.modelMatch) - Number(a.modelMatch)
            || Number(b.exactPhrase) - Number(a.exactPhrase)
            || b.keywordHits - a.keywordHits
            || b.searchResult.score - a.searchResult.score
            || Number(Boolean(b.liveSession)) - Number(Boolean(a.liveSession))
            || ((b.liveSession?.activeAt ?? b.searchResult.activeAt ?? 0) - (a.liveSession?.activeAt ?? a.searchResult.activeAt ?? 0))
        )

        return ranked[0] ?? null
    }

    // ===== 1. session_create =====
    const createSchema: z.ZodTypeAny = z.object({
        directory: z.string().describe('工作目录的绝对路径，如 /home/guang/softwares/yoho-remote'),
        machineId: z.string().optional().describe(`目标机器 ID。不填时默认使用当前 Brain 的默认机器（${defaultMachineId.slice(0, 8)}）。`),
        agent: z.string().optional().describe(`子 session agent。允许值：${describeAllowedValues(allowedChildAgents)}；默认 ${defaultChildAgent}${allowedChildAgents.length > 1 ? '，若目标机器不支持则自动切到当前 Brain 允许的其它 agent' : ''}。`),
        modelMode: z.string().optional().describe(`Claude 模型（agent=claude 时生效）。允许值：${describeAllowedValues(allowedClaudeModels)}；默认 ${defaultClaudeModel}。`),
        codexModel: z.string().optional().describe(`Codex 模型（agent=codex 时生效）。允许值：${describeAllowedValues(allowedCodexModels)}；默认 ${defaultCodexModel}。`),
    })

    mcp.registerTool<any, any>('session_create', {
        title: 'Create Session',
        description: buildBrainCreateDescription(MODEL_SELECTION_GUIDE),
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
                const statusText = ready
                    ? '已上线（如仍在初始化，首条任务会自动排队）'
                    : '启动中（可能需要等待几秒）'
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session 创建成功。\n\nsessionId: ${spawnResult.sessionId}\n状态: ${statusText}${machineNote}${skipNote}`,
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
        agent: z.string().optional().describe(`子 session agent。允许值：${describeAllowedValues(allowedChildAgents)}；默认 ${defaultChildAgent}${allowedChildAgents.length > 1 ? '，若目标机器不支持则自动切到当前 Brain 允许的其它 agent' : ''}。`),
        modelMode: z.string().optional().describe(`Claude 模型（agent=claude 时生效）。允许值：${describeAllowedValues(allowedClaudeModels)}；默认 ${defaultClaudeModel}。`),
        codexModel: z.string().optional().describe(`Codex 模型（agent=codex 时生效）。允许值：${describeAllowedValues(allowedCodexModels)}；默认 ${defaultCodexModel}。`),
    })

    mcp.registerTool<any, any>('session_find_or_create', {
        title: 'Find or Create Session',
        description: buildBrainFindOrCreateDescription(MODEL_SELECTION_GUIDE),
        inputSchema: findOrCreateSchema,
    }, async (args: { directory: string; hint?: string; machineId?: string; agent?: string; modelMode?: string; codexModel?: string }) => {
        try {
            const resolved = await resolveMachineAndAgent(args.machineId, args.agent, args.modelMode, args.codexModel)
            const { candidateMachineIds } = resolved
            const targetModel = resolved.agent === 'codex'
                ? (resolved.codexModel || 'gpt-5.4')
                : (resolved.modelMode || defaultClaudeModel)

            // Step 1: List online sessions
            const data = await api.listSessions({ includeOffline: false, mainSessionId: brainSessionId })

            // Step 2: Find reusable child session on the selected machine
            const candidates = data.sessions.filter((s) => {
                if (!s.metadata) return false
                if (s.metadata.source !== 'brain-child') return false
                if (s.metadata.mainSessionId !== brainSessionId) return false
                if (s.metadata.path !== args.directory) return false
                if (!s.metadata.machineId || !candidateMachineIds.has(s.metadata.machineId)) return false
                if (!s.active) return false
                if (s.initDone === false) return false
                if (s.thinking) return false
                if (s.pendingRequestsCount > 0) return false
                const sessionFlavor = s.metadata.flavor || 'claude'
                if (sessionFlavor !== resolved.agent) return false
                return true
            })

            try {
                const historicalMatch = await findHistoricalReusableSession({
                    directory: args.directory,
                    hint: args.hint,
                    agent: resolved.agent,
                    targetModel,
                    candidateMachineIds,
                    activeCandidates: candidates,
                })

                if (historicalMatch) {
                    const { searchResult, liveSession, matchReason } = historicalMatch
                    const title = searchResult.metadata.summary?.text || searchResult.metadata.brainSummary || '未命名'
                    const summary = searchResult.metadata.brainSummary ? `\n上次总结: ${searchResult.metadata.brainSummary}` : ''
                    const sessionMachineId = searchResult.metadata.machineId
                    const machineNote = sessionMachineId && sessionMachineId !== defaultMachineId
                        ? `\n机器: ${sessionMachineId.slice(0, 8)}`
                        : ''

                    if (liveSession) {
                        return {
                            content: [{
                                type: 'text' as const,
                                text: `复用已有 Session。\n\nsessionId: ${liveSession.id}\n标题: ${title}\n匹配: ${matchReason}${machineNote}${summary}\n状态: ✅ 空闲`,
                            }],
                        }
                    }

                    const resumed = await api.resumeSession(searchResult.sessionId)
                    const resumedLabel = resumed.type === 'created'
                        ? `原 session ${searchResult.sessionId} 已转为新的恢复 session`
                        : '已恢复历史 Session'
                    return {
                        content: [{
                            type: 'text' as const,
                            text: `${resumedLabel}。\n\nsessionId: ${resumed.sessionId}\n标题: ${title}\n匹配: ${matchReason}${machineNote}${summary}`,
                        }],
                    }
                }
            } catch (error: any) {
                logger.debug(`[brain] Historical session reuse failed, falling back to active/create path: ${error?.message || String(error)}`)
            }

            // Pick the best candidate: prefer model match, then context-relevant (hint matches brainSummary), then most recently active
            if (candidates.length > 0) {
                let best = candidates.sort((a, b) => b.activeAt - a.activeAt)[0]
                let matchReason = '最近活跃'
                const exactModelMatches = candidates.filter(s => {
                    return normalizeReuseModel(s.modelMode) === normalizeReuseModel(targetModel)
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
                const statusText = ready
                    ? '已上线（如仍在初始化，首条任务会自动排队）'
                    : '启动中（可能需要等待几秒）'
                return {
                    content: [{
                        type: 'text' as const,
                        text: `无可复用 session，已创建新 session。\n\nsessionId: ${spawnResult.sessionId}\n状态: ${statusText}${machineNote}${skipNote}`,
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
        description: BRAIN_SESSION_SEND_DESCRIPTION,
        inputSchema: sendSchema,
    }, async (args: { sessionId: string; message: string }) => {
        try {
            let session = null
            try {
                session = await api.getSession(args.sessionId)
            } catch {
                session = null
            }

            const metadataPatch: Record<string, unknown> = {}
            if (session?.metadata?.source === 'brain-child') {
                if (!session.metadata?.mainSessionId) {
                    metadataPatch.mainSessionId = brainSessionId
                }
                if (!session.metadata?.caller && sessionCaller) {
                    metadataPatch.caller = sessionCaller
                }
                if (!session.metadata?.brainPreferences && brainPreferences) {
                    metadataPatch.brainPreferences = brainPreferences
                }
            }
            if (Object.keys(metadataPatch).length > 0) {
                await api.patchSessionMetadata(args.sessionId, metadataPatch)
                logger.debug(`[brain] Repaired missing brain metadata for child session ${args.sessionId}`)
            }

            const delivery = await api.sendMessageToSession(args.sessionId, args.message, 'brain')

            if (delivery.status === 'delivered') {
                logger.debug(`[brain] Message delivered to session ${args.sessionId}, returning immediately (async callback mode)`)
                return {
                    content: [{
                        type: 'text' as const,
                        text: `任务已发送到 Session ${args.sessionId}。\n\n子 session 正在后台执行，完成后结果会自动推送到你的对话中。你可以继续处理其他任务。`,
                    }],
                    structuredContent: {
                        delivery,
                    },
                }
            }

            if (delivery.status === 'queued') {
                const queueText = delivery.queue === 'brain-session-inbox'
                    ? `消息已进入 Brain 会话 ${args.sessionId} 的消费队列，当前轮结束后会按既有顺序自动继续处理。\n\n不需要重复发送；如果是纠偏/改派，等下一轮开始前再补充说明即可。`
                    : `任务已进入 Session ${args.sessionId} 的轻量排队区，等待子 session 完成初始化后自动投递。\n\n这一步只处理初始化前缓冲，初始化完成后仍按 session 自身的消息队列继续消费。`
                return {
                    content: [{
                        type: 'text' as const,
                        text: queueText,
                    }],
                    structuredContent: {
                        delivery,
                    },
                }
            }

            if (delivery.status === 'busy') {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session ${args.sessionId} 正在处理上一个任务，当前消息未投递。\n\n请等待 child callback；如果确认要改派或纠偏，先调用 session_stop，再重新 session_send。`,
                    }],
                    structuredContent: {
                        delivery,
                    },
                }
            }

            if (delivery.status === 'offline') {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session ${args.sessionId} 当前不在线，消息未投递。\n\n请先调用 session_resume；如果恢复返回了新的 sessionId，后续必须改用新的 sessionId 再 session_send。`,
                    }],
                    structuredContent: {
                        delivery,
                    },
                }
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: delivery.status === 'access_denied'
                        ? `Session ${args.sessionId} 无权访问，消息未投递。`
                        : `Session ${args.sessionId} 未找到，消息未投递。`,
                }],
                structuredContent: {
                    delivery,
                },
                isError: true,
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
        title: 'List Child Sessions',
        description: BRAIN_SESSION_LIST_DESCRIPTION,
        inputSchema: listSchema,
    }, async (args: { includeOffline?: boolean }) => {
        try {
            const data = await api.listSessions({ includeOffline: args.includeOffline, mainSessionId: brainSessionId })
            if (!data.sessions || data.sessions.length === 0) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: '当前 Brain 下面没有任何子 session。',
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
                    text: `当前 Brain 子 sessions (${data.sessions.length}):\n${lines.join('\n')}`,
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

    // ===== 5. session_stop / session_abort =====
    const stopSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('要停止当前任务的 session ID'),
    })

    const handleStopSession = async (args: { sessionId: string }) => {
        try {
            const status = await api.getSessionStatus(args.sessionId, childSessionScope)
            if (!status.active) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session ${args.sessionId} 当前不在线，无需 stop。如果还想复用上下文，请先调用 session_resume。`,
                    }],
                }
            }

            if (!status.thinking) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session ${args.sessionId} 当前是空闲状态，无需 stop。可以直接调用 session_send 发送新的纠偏任务。`,
                    }],
                }
            }

            const result = await api.abortSession(args.sessionId)
            if (result.ok) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session ${args.sessionId} 的当前任务已停止。该 session 会被保留，现在可以继续 session_send 新任务做纠偏或改派。`,
                    }],
                }
            }
            return {
                content: [{
                    type: 'text' as const,
                    text: '停止失败: 操作未成功。',
                }],
                isError: true,
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `停止失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    }

    mcp.registerTool<any, any>('session_stop', {
        title: 'Stop Session Task',
        description: BRAIN_SESSION_STOP_DESCRIPTION,
        inputSchema: stopSchema,
    }, handleStopSession)

    mcp.registerTool<any, any>('session_abort', {
        title: 'Abort Session Task',
        description: `${BRAIN_SESSION_ABORT_DESCRIPTION} 这是 session_stop 的兼容别名。`,
        inputSchema: stopSchema,
    }, handleStopSession)

    // ===== 6. session_resume =====
    const resumeSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('要恢复的 session ID'),
    })

    mcp.registerTool<any, any>('session_resume', {
        title: 'Resume Session',
        description: BRAIN_SESSION_RESUME_DESCRIPTION,
        inputSchema: resumeSchema,
    }, async (args: { sessionId: string }) => {
        try {
            const result = await api.resumeSession(args.sessionId)
            if (result.type === 'already-active') {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session ${result.sessionId} 已经在线，无需恢复。可以直接 session_send 新任务。`,
                    }],
                }
            }

            if (result.type === 'resumed') {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session ${result.sessionId} 已恢复上线，可以继续 session_send 新任务。`,
                    }],
                }
            }

            return {
                content: [{
                    type: 'text' as const,
                    text: `原 session ${args.sessionId} 无法原地恢复，已改为创建新的恢复 session ${result.sessionId}。\n后续请改用新的 sessionId 继续 session_send。`,
                }],
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `恢复失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    })

    // ===== 7. session_close =====
    const closeSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('要关闭的 session ID'),
    })

    mcp.registerTool<any, any>('session_close', {
        title: 'Close Session',
        description: '关闭指定 session。仅在这个子 session 不再需要时使用；如果只是要停止当前任务并继续复用同一 session，请改用 session_stop。',
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

    // ===== 8. session_update =====
    const updateSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('目标 session ID'),
        brainSummary: z.string().describe('Brain 写入的任务总结（持久化到 session metadata）'),
    })

    mcp.registerTool<any, any>('session_update', {
        title: 'Update Session',
        description: BRAIN_SESSION_UPDATE_DESCRIPTION,
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

    // ===== 9. session_status =====
    const statusSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('要查询的 session ID'),
    })

    mcp.registerTool<any, any>('session_status', {
        title: 'Child Session Status',
        description: BRAIN_SESSION_STATUS_DESCRIPTION,
        inputSchema: statusSchema,
    }, async (args: { sessionId: string }) => {
        try {
            const status = await api.getSessionStatus(args.sessionId, childSessionScope)

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

    // ===== 10. session_inspect =====
    const inspectSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('要检查的 session ID'),
    })

    mcp.registerTool<any, any>('session_inspect', {
        title: 'Child Session Inspect',
        description: BRAIN_SESSION_INSPECT_DESCRIPTION,
        inputSchema: inspectSchema,
    }, async (args: { sessionId: string }) => {
        try {
            const inspect = await api.getSessionInspect(args.sessionId, childSessionScope)
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify(inspect, null, 2),
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

    // ===== 11. session_tail =====
    const tailSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('要查看 tail 的 session ID'),
        limit: z.number().int().min(1).max(20).optional().describe('返回多少条最近片段，默认 6，最大 20'),
    })

    mcp.registerTool<any, any>('session_tail', {
        title: 'Child Session Tail',
        description: BRAIN_SESSION_TAIL_DESCRIPTION,
        inputSchema: tailSchema,
    }, async (args: { sessionId: string; limit?: number }) => {
        try {
            const tail = await api.getSessionTail(args.sessionId, { limit: args.limit, mainSessionId: brainSessionId })
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify(tail, null, 2),
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

    // ===== 12. session_set_config / session_set_model_mode =====
    const setConfigSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('目标 session ID'),
        model: z.string().optional().describe('要切换到的模型。Claude 常见值：sonnet / opus / opus-4-7 / glm-5.1；Codex 常见值：gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex / gpt-5.3-codex-spark / gpt-5.2 / gpt-5.2-codex / gpt-5.1-codex-max / gpt-5.1-codex-mini。'),
        reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional().describe('推理强度。当前主要适用于 Codex；Claude 运行时不支持单独调整 reasoningEffort。'),
        permissionMode: z.enum(['default', 'bypassPermissions', 'read-only', 'safe-yolo', 'yolo']).optional().describe('权限模式。Claude 仅支持 bypassPermissions；Codex 支持 default / read-only / safe-yolo / yolo。'),
        fastMode: z.boolean().optional().describe('Claude Fast Mode 开关。当前仅适用于 Claude。'),
    }).refine((value) =>
        value.model !== undefined
        || value.reasoningEffort !== undefined
        || value.permissionMode !== undefined
        || value.fastMode !== undefined,
    {
        message: '至少提供一个要修改的配置字段',
    })

    const handleSetSessionConfig = async (args: {
        sessionId: string
        model?: string
        reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
        permissionMode?: 'default' | 'bypassPermissions' | 'read-only' | 'safe-yolo' | 'yolo'
        fastMode?: boolean
    }) => {
        try {
            const status = await api.getSessionStatus(args.sessionId, childSessionScope)
            if (!status.active) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session ${args.sessionId} 当前不在线，无法调整运行时配置。请先调用 session_resume 恢复它。`,
                    }],
                }
            }

            const result = await api.setSessionConfig(args.sessionId, {
                ...(args.model !== undefined ? { model: args.model } : {}),
                ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
                ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
                ...(args.fastMode !== undefined ? { fastMode: args.fastMode } : {}),
            })

            const appliedLines = [
                result.applied?.model !== undefined ? `model: ${result.applied.model}` : null,
                result.applied?.reasoningEffort !== undefined ? `reasoningEffort: ${result.applied.reasoningEffort}` : null,
                result.applied?.permissionMode !== undefined ? `permissionMode: ${result.applied.permissionMode}` : null,
                result.applied?.fastMode !== undefined ? `fastMode: ${result.applied.fastMode ? 'on' : 'off'}` : null,
            ].filter((line): line is string => Boolean(line))

            return {
                content: [{
                    type: 'text' as const,
                    text: appliedLines.length > 0
                        ? `已更新 Session ${args.sessionId} 的运行时配置：\n${appliedLines.join('\n')}`
                        : `已更新 Session ${args.sessionId} 的运行时配置。`,
                }],
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `更新配置失败: ${err.message || String(err)}`,
                }],
                isError: true,
            }
        }
    }

    mcp.registerTool<any, any>('session_set_config', {
        title: 'Set Session Config',
        description: BRAIN_SESSION_SET_CONFIG_DESCRIPTION,
        inputSchema: setConfigSchema,
    }, handleSetSessionConfig)

    const setModelModeSchema: z.ZodTypeAny = z.object({
        sessionId: z.string().describe('目标 session ID'),
        modelMode: z.string().min(1).describe('兼容旧接口：只修改 model。新代码优先用 session_set_config。'),
    })

    mcp.registerTool<any, any>('session_set_model_mode', {
        title: 'Set Session Model Mode',
        description: '兼容旧接口：只调整子 session 的 model。新代码优先使用 session_set_config，把 model / reasoningEffort / fastMode / permissionMode 放在同一个调用里。',
        inputSchema: setModelModeSchema,
    }, async (args: { sessionId: string; modelMode: string }) => {
        return await handleSetSessionConfig({
            sessionId: args.sessionId,
            model: args.modelMode,
        })
    })

    registerAskUserQuestionTool(mcp, toolNames)
    registerChatMessagesTool(mcp, toolNames, { apiClient: api })

    toolNames.push(
        'session_create',
        'session_find_or_create',
        'session_send',
        'session_list',
        'session_stop',
        'session_abort',
        'session_resume',
        'session_close',
        'session_update',
        'session_status',
        'session_inspect',
        'session_tail',
        'session_set_config',
        'session_set_model_mode',
    )

    logger.debug(`[brain] Registered ${toolNames.length - initialToolCount} brain tools (async mode) for session ${brainSessionId}`)
}
