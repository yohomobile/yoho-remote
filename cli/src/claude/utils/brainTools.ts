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
}

export function registerBrainTools(
    mcp: McpServer,
    toolNames: string[],
    options: BrainToolsOptions
): void {
    const { apiClient: api, machineId, brainSessionId } = options

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
    // Determines the best machine to use and validates/falls back the agent.
    //
    // When requestedMachineId is given → use that machine only (validate supportedAgents).
    // When not given → expand to all online machines in the same workspaceGroup as the
    //   Brain session's machine, then pick the best one that supports the requested agent.
    //
    // Returns: resolved machineId, agent, model params, the full candidate set (for
    //   session search across the group), an ordered list for spawn fallback, and an
    //   optional pre-spawn notice (agent remapped due to supportedAgents restriction).
    async function resolveMachineAndAgent(
        requestedMachineId: string | undefined,
        requestedAgent: string,
        requestedModelMode?: string,
        requestedCodexModel?: string,
    ): Promise<{
        machineId: string
        agent: string
        modelMode?: string
        codexModel?: string
        candidateMachineIds: Set<string>
        orderedCandidates: MachineCandidate[]  // primary first, for spawn fallback iteration
        fallbackNotice: string | null
    }> {
        const defaultId = requestedMachineId ?? machineId
        const fallback = {
            machineId: defaultId,
            agent: requestedAgent,
            modelMode: requestedModelMode,
            codexModel: requestedCodexModel,
            candidateMachineIds: new Set([defaultId]),
            orderedCandidates: [{ id: defaultId, displayName: defaultId.slice(0, 8) }],
            fallbackNotice: null as string | null,
        }

        try {
            const allMachines = await api.listMachines()
            const online = allMachines.filter(m => m.active)
            const displayOf = (m: typeof online[0]): string =>
                (m.metadata?.displayName || m.metadata?.host || m.id.slice(0, 8)) as string

            // ── Determine candidate set ──
            let candidates: typeof online
            if (requestedMachineId) {
                candidates = online.filter(m => m.id === requestedMachineId)
                if (candidates.length === 0) {
                    // Offline or unknown — let the server produce the error
                    return { ...fallback, candidateMachineIds: new Set([requestedMachineId]) }
                }
            } else {
                // Auto — expand to workspace group
                const brainMachine = online.find(m => m.id === machineId)
                const groupId = brainMachine?.metadata?.workspaceGroupId

                candidates = groupId
                    ? online.filter(m => m.metadata?.workspaceGroupId === groupId)
                    : online.filter(m => m.id === machineId)

                if (candidates.length === 0) {
                    // Brain's machine is offline or has no workspaceGroup — no candidates available
                    return { ...fallback, orderedCandidates: [], candidateMachineIds: new Set<string>(), fallbackNotice: null }
                }
            }

            const candidateMachineIds = new Set(candidates.map(m => m.id))

            // ── Find machines that support the requested agent ──
            const agentCompatible = candidates.filter(m =>
                !m.supportedAgents || m.supportedAgents.length === 0 || m.supportedAgents.includes(requestedAgent)
            )

            if (agentCompatible.length > 0) {
                // Prefer Brain's own machine to minimise latency; otherwise first compatible
                const pick = agentCompatible.find(m => m.id === machineId) ?? agentCompatible[0]
                // Build ordered candidate list: pick first, then remaining compatible, then incompatible as last resort
                const rest = agentCompatible.filter(m => m.id !== pick.id)
                const incompatible = candidates.filter(m => !agentCompatible.includes(m))
                const orderedCandidates: MachineCandidate[] = [...[pick, ...rest, ...incompatible].map(m => ({ id: m.id, displayName: displayOf(m) }))]
                return { machineId: pick.id, agent: requestedAgent, modelMode: requestedModelMode, codexModel: requestedCodexModel, candidateMachineIds, orderedCandidates, fallbackNotice: null }
            }

            // ── No candidate supports requested agent — pick best available and remap ──
            const pick = candidates.find(m => m.id === machineId) ?? candidates[0]
            const fallbackAgent = pick.supportedAgents?.[0] ?? requestedAgent
            let fallbackModelMode = requestedModelMode
            let fallbackCodexModel = requestedCodexModel

            if (fallbackAgent === 'claude' && requestedAgent === 'codex') {
                fallbackCodexModel = undefined
                fallbackModelMode = requestedCodexModel === 'gpt-5.4' ? 'opus' : 'sonnet'
            } else if (fallbackAgent === 'codex' && requestedAgent === 'claude') {
                fallbackModelMode = undefined
                fallbackCodexModel = requestedModelMode === 'opus' ? 'gpt-5.4' : 'gpt-5.4-mini'
            }

            const supported = pick.supportedAgents?.join(', ') || '全部'
            const modelLabel = fallbackAgent === 'claude' ? `/${fallbackModelMode || 'sonnet'}` : `/${fallbackCodexModel || 'gpt-5.4'}`
            const notice = `⚠️ 当前机器组没有机器支持 ${requestedAgent}，已选机器 "${displayOf(pick)}"（支持: ${supported}），切换为 ${fallbackAgent}${modelLabel}`
            const orderedCandidates: MachineCandidate[] = candidates.map(m => ({ id: m.id, displayName: displayOf(m) }))

            return { machineId: pick.id, agent: fallbackAgent, modelMode: fallbackModelMode, codexModel: fallbackCodexModel, candidateMachineIds, orderedCandidates, fallbackNotice: notice }
        } catch {
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
        machineId: z.string().optional().describe('目标机器 ID。不填时自动从当前机器所在的 workspaceGroup 中选择最佳可用机器（支持所需 agent 的优先）。'),
        agent: z.enum(['claude', 'codex']).optional().describe('Agent 后端。claude（默认）= Claude Code CLI，codex = OpenAI Codex CLI。根据任务特性选择，详见 description。'),
        modelMode: z.enum(['default', 'sonnet', 'opus']).optional().describe('Claude 模型选择（agent=claude 时生效）。sonnet 默认，opus 用于高复杂度任务。'),
        codexModel: z.enum(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark']).optional().describe('Codex 模型选择（agent=codex 时生效）。gpt-5.4 默认旗舰，gpt-5.4-mini 更快更省，gpt-5.3-codex 纯编码优化，gpt-5.3-codex-spark 超快速迭代。'),
    })

    const MODEL_SELECTION_GUIDE = [
        '模型选择指南（2026 年 4 月）：',
        '',
        '【Claude 系列】 agent=claude — 擅长：遵循复杂指令、代码理解与重构、中文交互、谨慎安全的代码修改',
        '  • sonnet（默认）— 90% 的任务首选。日常开发、bug 修复、写测试、代码补全、文档、脚本、标准功能开发。速度快，性价比最高。',
        '  • opus — 10% 的高复杂度任务。大规模代码库重构（数万行架构调整）、安全审计、跨多文件的深度架构设计、需要极深推理的多步任务。成本 5x sonnet，推理深度更强。',
        '',
        '【Codex 系列】 agent=codex — 擅长：新颖/困难的编码问题、SWE-bench Pro 得分更高、强推理 + 工具使用',
        '  • gpt-5.4（默认）— Codex 旗舰。新颖编码难题（SWE-bench Pro 57.7%）、复杂算法、跨语言、前端 UI、多文件变更。综合能力最强。',
        '  • gpt-5.4-mini — 快速低成本。SWE-bench Pro 54.38%（接近 5.4），速度 2x+，成本 1/6。适合子任务并行、批量编码、轻量修改。',
        '  • gpt-5.3-codex — 纯编码专精。专为编码环境优化，标准编码任务的高效选择。',
        '  • gpt-5.3-codex-spark — 超快速编码。1000+ tokens/sec，近乎实时。适合快速迭代、原型验证、需要极低延迟的交互式编码。',
        '',
        '决策流程：',
        '1. 大多数任务 → claude + sonnet',
        '2. 需要深度架构推理/安全审计 → claude + opus',
        '3. 新颖/困难编码 + 需要强推理 → codex + gpt-5.4',
        '4. 子任务并行/轻量编码 → codex + gpt-5.4-mini',
        '5. 纯编码专精 → codex + gpt-5.3-codex',
        '6. 快速迭代/原型验证/极低延迟 → codex + gpt-5.3-codex-spark',
    ].join('\n')

    mcp.registerTool<any, any>('session_create', {
        title: 'Create Session',
        description: `强制创建新的工作 session。如果只想发任务到已有目录，优先使用 session_find_or_create 来复用空闲 session。\n\n${MODEL_SELECTION_GUIDE}`,
        inputSchema: createSchema,
    }, async (args: { directory: string; machineId?: string; agent?: string; modelMode?: string; codexModel?: string }) => {
        try {
            const resolved = await resolveMachineAndAgent(args.machineId, args.agent || 'claude', args.modelMode, args.codexModel)
            logger.debug(`[brain] Creating session: machine=${resolved.machineId}, dir=${args.directory}, agent=${resolved.agent}${resolved.fallbackNotice ? ' (agent-fallback)' : ''}`)

            const spawnResult = await spawnWithFallback({
                orderedCandidates: resolved.orderedCandidates,
                agent: resolved.agent,
                modelMode: resolved.modelMode,
                codexModel: resolved.codexModel,
                directory: args.directory,
            })

            if (spawnResult.type === 'success') {
                const ready = await waitForSessionOnline(spawnResult.sessionId)
                const agentNotice = resolved.fallbackNotice ? `\n${resolved.fallbackNotice}` : ''
                const machineNote = spawnResult.machineId !== machineId
                    ? `\n机器: ${spawnResult.machineId.slice(0, 8)}（workspaceGroup 内其他机器）`
                    : ''
                const skipNote = spawnResult.skippedLog.length > 0
                    ? `\n⚠️ 已跳过 ${spawnResult.skippedLog.length} 台失败机器:\n${spawnResult.skippedLog.map(s => `  - ${s}`).join('\n')}`
                    : ''
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Session 创建成功。\n\nsessionId: ${spawnResult.sessionId}\n状态: ${ready ? '已上线' : '启动中（可能需要等待几秒）'}${machineNote}${skipNote}${agentNotice}`,
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
        machineId: z.string().optional().describe('目标机器 ID。不填时自动搜索当前机器所在 workspaceGroup 内所有在线机器的空闲 session，找不到则在最佳机器上创建新 session。'),
        agent: z.enum(['claude', 'codex']).optional().describe('Agent 后端。claude（默认）= Claude Code CLI，codex = OpenAI Codex CLI。'),
        modelMode: z.enum(['default', 'sonnet', 'opus']).optional().describe('Claude 模型选择（agent=claude 时生效）。'),
        codexModel: z.enum(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark']).optional().describe('Codex 模型选择（agent=codex 时生效）。'),
    })

    mcp.registerTool<any, any>('session_find_or_create', {
        title: 'Find or Create Session',
        description: `智能查找可复用的空闲子 session。在 workspaceGroup 内所有在线机器上搜索匹配 directory + 属于当前 Brain + agent 的空闲 session，并通过 hint 优先选择上下文相关的 session。找不到则在最佳机器上创建新 session。推荐优先使用此工具。\n\n${MODEL_SELECTION_GUIDE}\n\n复用逻辑：优先匹配相同 agent + modelMode 的 session。`,
        inputSchema: findOrCreateSchema,
    }, async (args: { directory: string; hint?: string; machineId?: string; agent?: string; modelMode?: string; codexModel?: string }) => {
        try {
            const targetAgent = args.agent || 'claude'
            const targetModelMode = args.modelMode || 'sonnet'

            // Resolve machine candidates (workspace group expansion) + agent/model for creation
            const resolved = await resolveMachineAndAgent(args.machineId, targetAgent, args.modelMode, args.codexModel)
            const { candidateMachineIds } = resolved

            // Step 1: List online sessions
            const data = await api.listSessions({ includeOffline: false })

            // Step 2: Find reusable child session across all candidate machines
            const candidates = data.sessions.filter(s => {
                if (!s.metadata) return false
                if (s.metadata.source !== 'brain-child') return false
                if (s.metadata.mainSessionId !== brainSessionId) return false
                if (s.metadata.path !== args.directory) return false
                // Accept sessions on any machine in the candidate set (workspace group)
                // Reject sessions with no machineId, or on machines outside the candidate set
                if (!s.metadata.machineId || !candidateMachineIds.has(s.metadata.machineId)) return false
                if (!s.active) return false
                if (s.thinking) return false
                // Don't reuse sessions with pending permission requests
                if (s.pendingRequestsCount > 0) return false
                // Match agent type using resolved agent (accounts for agent remap when requested agent unavailable)
                const sessionFlavor = s.metadata.flavor || 'claude'
                if (sessionFlavor !== resolved.agent) return false
                return true
            })

            // Pick the best candidate: prefer model match, then context-relevant (hint matches brainSummary), then most recently active
            if (candidates.length > 0) {
                let best = candidates.sort((a, b) => b.activeAt - a.activeAt)[0]
                let matchReason = '最近活跃'

                // Step 1: Prefer exact model match
                // For claude sessions, match by modelMode; for codex sessions, match by codexModel (stored as modelMode)
                // Use resolved agent/model (not raw args) to correctly handle agent-remap scenarios
                const normalizeModel = (mode?: string) => {
                    if (!mode || mode === 'default') return 'sonnet'
                    return mode
                }
                const targetModel = resolved.agent === 'codex'
                    ? (resolved.codexModel || 'gpt-5.4')
                    : (resolved.modelMode || targetModelMode)
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
                const machineNote = sessionMachineId && sessionMachineId !== machineId
                    ? `\n机器: ${sessionMachineId.slice(0, 8)}（workspaceGroup 内其他机器）`
                    : ''
                return {
                    content: [{
                        type: 'text' as const,
                        text: `复用已有 Session。\n\nsessionId: ${best.id}\n标题: ${title}\n匹配: ${matchReason}${machineNote}${summary}\n状态: ✅ 空闲`,
                    }],
                }
            }

            // Step 3: No reusable session — create on the best resolved machine (with fallback)
            logger.debug(`[brain] No reusable session for dir=${args.directory}, agent=${resolved.agent}, machine=${resolved.machineId}${resolved.fallbackNotice ? ' (agent-fallback)' : ''}`)

            const spawnResult = await spawnWithFallback({
                orderedCandidates: resolved.orderedCandidates,
                agent: resolved.agent,
                modelMode: resolved.modelMode,
                codexModel: resolved.codexModel,
                directory: args.directory,
            })

            if (spawnResult.type === 'success') {
                const ready = await waitForSessionOnline(spawnResult.sessionId)
                const agentNotice = resolved.fallbackNotice ? `\n${resolved.fallbackNotice}` : ''
                const machineNote = spawnResult.machineId !== machineId
                    ? `\n机器: ${spawnResult.machineId.slice(0, 8)}（workspaceGroup 内其他机器）`
                    : ''
                const skipNote = spawnResult.skippedLog.length > 0
                    ? `\n⚠️ 已跳过 ${spawnResult.skippedLog.length} 台失败机器:\n${spawnResult.skippedLog.map(s => `  - ${s}`).join('\n')}`
                    : ''
                return {
                    content: [{
                        type: 'text' as const,
                        text: `无可复用 session，已创建新 session。\n\nsessionId: ${spawnResult.sessionId}\n状态: ${ready ? '已上线' : '启动中（可能需要等待几秒）'}${machineNote}${skipNote}${agentNotice}`,
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
