import { describe, expect, it } from 'bun:test'
import { buildAutomationPreamble, buildBrainInitPrompt, buildInitPrompt } from './initPrompt'
import { renderSessionContextBundlePrompt, type SessionContextBundle } from './contextBundle'

describe('buildInitPrompt', () => {
    it('renders the standard workspace section for regular sessions', async () => {
        const prompt = await buildInitPrompt('developer', {
            projectRoot: '/workspace/yoho-remote',
            userName: 'Guang Yang'
        })

        expect(prompt).toContain('当前会话工作目录：/workspace/yoho-remote')
        expect(prompt).not.toContain('当前会话基仓库目录：')
        expect(prompt).not.toContain('当前会话使用 Git worktree 隔离开发')
        expect(prompt).not.toContain('开发规范（不可违背）')
        expect(prompt).not.toContain('部署 dev 环境前，必须确认代码已合入 `dev-release`')
        expect(prompt).not.toContain('部署线上环境前，必须确认代码已合入 `main`')
        expect(prompt).toContain('mcp__yoho_remote__environment_info')
        expect(prompt).toContain('不要通过 `claude mcp list`')
        expect(prompt).toContain('skill_list` 不再作为非简单任务的必调前置步骤')
        expect(prompt).toContain('skill_search')
        expect(prompt).toContain('方法/能力类 skill')
        expect(prompt).toContain('activationMode=manual')
        expect(prompt).toContain('skill_save` 只生成 candidate')
        expect(prompt).toContain('skill_update` 只生成 draft')
        expect(prompt).toContain('skill_promote')
        expect(prompt).toContain('skill_doctor')
        expect(prompt).toContain('allowActive=true')
        expect(prompt).toContain('skill_discover')
        expect(prompt).toContain('functions.yoho_remote__environment_info')
        expect(prompt.trimEnd().endsWith('请调用一次 `functions.yoho_remote__environment_info`，然后直接回复“收到！”。')).toBe(true)
    })

    it('renders machine-local project guidance without worktree instructions', async () => {
        const prompt = await buildInitPrompt('developer', {
            projectRoot: '/vm/shared/yoho-remote'
        })

        expect(prompt).toContain('当前会话工作目录：/vm/shared/yoho-remote')
        expect(prompt).toContain('绑定到具体机器')
        expect(prompt).not.toContain('所有查看、编辑、测试、提交都必须在当前会话目录进行')
        expect(prompt).not.toContain('Git worktree')
        expect(prompt).toContain('`recall` 是按需深查工具')
        expect(prompt).toContain('mcp__yoho-memory__remember')
        expect(prompt).toContain('不要因为有相似关键词就硬套 skill')
    })

    it('injects ContextBundle and makes recall/remember/skill_list on-demand', async () => {
        const bundle: SessionContextBundle = {
            version: 1,
            orgId: 'org-a',
            sessionId: 'session-a',
            generatedAtMs: 1,
            summaries: {
                recentL1: [{
                    id: 'l1-a',
                    level: 1,
                    summary: '最近一轮修复了 worker L1 orgId 隔离。',
                    topic: 'worker orgId',
                    seqStart: 10,
                    seqEnd: 12,
                    createdAt: 1,
                }],
                latestL2: [],
                latestL3: null,
            },
            toolPolicy: {
                recallDefault: 'fallback',
                rememberDefault: 'explicit_or_gap_only',
                skillListDefault: 'injected_manifest_or_on_demand',
            },
        }
        const contextBundlePrompt = renderSessionContextBundlePrompt(bundle)
        const prompt = await buildInitPrompt('developer', { contextBundlePrompt })

        expect(prompt).toContain('Yoho ContextBundle（自动上下文，优先使用）')
        expect(prompt).toContain('orgId: org-a')
        expect(prompt).toContain('L1 seq=10-12 topic=worker orgId id=l1-a')
        expect(prompt).toContain('`recall` 是按需深查工具')
        expect(prompt).toContain('remember 默认由 L1/L2/L3 worker 异步沉淀')
        expect(prompt).toContain('skill_list 默认不必每轮调用')
    })

    it('uses the same shared-directory rules in brain init prompts', async () => {
        const prompt = await buildBrainInitPrompt('developer', {
            projectRoot: '/vm/shared/yoho-remote'
        })

        expect(prompt).toContain('当前会话工作目录：/vm/shared/yoho-remote')
        expect(prompt).not.toContain('Git worktree')
        expect(prompt).not.toContain('部署 dev 必须先合入 dev-release')
        expect(prompt).not.toContain('部署线上必须先合入 main')
        expect(prompt).toContain('不要通过 `claude mcp list`')
        expect(prompt).toContain('才调用 `mcp__yoho-vault__skill_list`')
        expect(prompt).toContain('skill_search')
        expect(prompt).toContain('activationMode=manual')
        expect(prompt).toContain('不要让未确认的 candidate/draft 进入 active')
        expect(prompt).toContain('不要把噪声 skill 传给子 session')
        expect(prompt).toContain('skill_promote')
        expect(prompt).toContain('skill_doctor')
        expect(prompt).toContain('发完任务后默认结束当前轮，不主动轮询 `session_list` / `session_status`')
        expect(prompt).toContain('默认先用 `session_find_or_create` 复用 session')
        expect(prompt).toContain('用 `session_update` 写一行可复用总结')
        expect(prompt).toContain('分工协作、多 session 复用、密集配合是默认工作方式')
        expect(prompt).toContain('默认至少发两路独立调研或验证')
        expect(prompt).toContain('Brain 不只是派单，还要监督每个子 session 的方向是否正确、质量是否达标')
        expect(prompt).toContain('默认把用户的新消息当作补充信息')
        expect(prompt).toContain('只有在以下情况才 stop')
        expect(prompt).toContain('用户**明确**要求停掉旧任务/取消旧任务/切换方向')
        expect(prompt).toContain('新增并行工作，默认保持原分工继续执行')
        expect(prompt).toContain('先用 `session_resume` 恢复')
        expect(prompt).toContain('优先用 `session_set_config`')
        expect(prompt).toContain('Brain 自己不是编码工作台')
        expect(prompt).toContain('`WebSearch` / `WebFetch`')
        expect(prompt).toContain('不要假设有 `Read` / `Edit` / `Write` / `Bash` / `Grep` / `Glob` / `Task` / `AskUserQuestion`')
        expect(prompt).toContain('`mcp__yoho_remote__ask_user_question`')
        expect(prompt).toContain('不是 `request_user_input` 别名')
        expect(prompt).toContain('只要方向没问题、不会影响线上，就直接决策并推进')
        expect(prompt).toContain('用户未指定阶段时，默认持续推进到部署前准备完成')
        expect(prompt).toContain('彻底 review 两遍，测试两遍，部署前检查两遍')
        expect(prompt).toContain('有 bug 就一直改到没有为止')
        expect(prompt).toContain('默认继续复用同一 session 往下修')
        expect(prompt).toContain('只有明确跑偏或继续旧任务已无意义时')
        expect(prompt).toContain('只有大的决定、方向上的决定、权限、部署推进需要人拍板')
        expect(prompt).toContain('先用人话给判断')
        expect(prompt).toContain('不默认回显 sessionId、token、context 等系统字段')
    })

    it('renders brain child-session capability boundaries from session preferences', async () => {
        const prompt = await buildBrainInitPrompt('developer', {
            projectRoot: '/vm/shared/yoho-remote',
            brainPreferences: {
                machineSelection: {
                    mode: 'manual',
                    machineId: 'machine-1',
                },
                childModels: {
                    claude: {
                        allowed: ['opus'],
                        defaultModel: 'opus',
                    },
                    codex: {
                        allowed: [],
                        defaultModel: 'gpt-5.4',
                    },
                },
            },
        })

        expect(prompt).toContain('当前 Brain 的子任务边界')
        expect(prompt).toContain('默认子 session 机器：当前 Brain 所在机器（由用户手动固定）')
        expect(prompt).toContain('Claude 子 session 可用模型：opus；默认 opus')
        expect(prompt).toContain('Codex 子 session：禁用（当前 Brain 不允许创建 Codex 子任务）')
        expect(prompt).toContain('不在以上白名单里的模型不要使用')
    })

    it('renders only the actually allowed model rows in the model selection section', async () => {
        const prompt = await buildBrainInitPrompt('developer', {
            brainPreferences: {
                machineSelection: {
                    mode: 'auto',
                    machineId: 'machine-1',
                },
                childModels: {
                    claude: {
                        allowed: ['opus'],
                        defaultModel: 'opus',
                    },
                    codex: {
                        allowed: ['gpt-5.4-mini', 'gpt-5.3-codex'],
                        defaultModel: 'gpt-5.4-mini',
                    },
                },
            },
        })

        expect(prompt).toContain('| claude | opus（默认） |')
        expect(prompt).toContain('| codex | gpt-5.4-mini（默认） |')
        expect(prompt).toContain('| codex | gpt-5.3-codex |')
        expect(prompt).not.toContain('| claude | sonnet（默认） |')
        expect(prompt).not.toContain('| codex | gpt-5.4（默认） |')
        expect(prompt).not.toContain('gpt-5.3-codex-spark')
    })

    it('omits models and agents that are not allowed for this brain session', async () => {
        const prompt = await buildBrainInitPrompt('developer', {
            brainPreferences: {
                machineSelection: {
                    mode: 'manual',
                    machineId: 'machine-1',
                },
                childModels: {
                    claude: {
                        allowed: ['opus-4-7'],
                        defaultModel: 'opus-4-7',
                    },
                    codex: {
                        allowed: [],
                        defaultModel: 'gpt-5.4',
                    },
                },
            },
        })

        expect(prompt).toContain('| claude | opus-4-7（默认） |')
        expect(prompt).not.toContain('| codex |')
        expect(prompt).not.toContain('gpt-5.4-mini')
        expect(prompt).not.toContain('gpt-5.3-codex')
    })

    it('omits the bundled preamble content from the standard init prompt', async () => {
        const prompt = await buildInitPrompt('developer', { projectRoot: '/x' })

        // standard init prompt is for interactive sessions and should not advertise
        // itself as the automation single-shot variant.
        expect(prompt).not.toContain('Yoho 自动化任务')
        expect(prompt).not.toContain('当前任务的发起人：')
        expect(prompt).not.toContain('下面是要执行的任务：')
    })

    it('keeps the default model label correct when only part of the model range is allowed', async () => {
        const prompt = await buildBrainInitPrompt('developer', {
            brainPreferences: {
                machineSelection: {
                    mode: 'auto',
                    machineId: 'machine-1',
                },
                childModels: {
                    claude: {
                        allowed: ['sonnet', 'opus-4-7'],
                        defaultModel: 'sonnet',
                    },
                    codex: {
                        allowed: ['gpt-5.3-codex', 'gpt-5.4-mini'],
                        defaultModel: 'gpt-5.4-mini',
                    },
                },
            },
        })

        expect(prompt).toContain('| claude | sonnet（默认） |')
        expect(prompt).toContain('| claude | opus-4-7 |')
        expect(prompt).toContain('| codex | gpt-5.4-mini（默认） |')
        expect(prompt).toContain('| codex | gpt-5.3-codex |')
        expect(prompt).toContain('未出现在上表的模型当前不可用')
    })
})

describe('buildAutomationPreamble', () => {
    it('renders Yoho rules + MCP guidance + change_title for automation sessions', async () => {
        const prompt = await buildAutomationPreamble({
            projectRoot: '/workspace/yoho-task',
            userName: 'guang@example.com',
            scheduleLabel: 'daily backup',
        })

        expect(prompt).toContain('Yoho 自动化任务')
        expect(prompt).toContain('当前会话工作目录：/workspace/yoho-task')
        expect(prompt).toContain('当前任务的发起人：guang@example.com')
        expect(prompt).toContain('始终使用中文')
        expect(prompt).toContain('永远不使用 docker')
        expect(prompt).toContain('mcp__yoho_remote__environment_info')
        expect(prompt).toContain('mcp__yoho_remote__change_title')
        expect(prompt).toContain('任务定义为：daily backup')
        expect(prompt).toContain('调用 `mcp__yoho-vault__recall`')
        expect(prompt).toContain('mcp__yoho-vault__get_credential')
        expect(prompt).toContain('mcp__yoho-vault__remember')
        expect(prompt).toContain('keywords')
        expect(prompt.trimEnd().endsWith('下面是要执行的任务：')).toBe(true)
    })

    it('drops the user line when userName is missing', async () => {
        const prompt = await buildAutomationPreamble({
            projectRoot: '/workspace/yoho-task',
        })

        expect(prompt).not.toContain('当前任务的发起人：')
    })

    it('drops the schedule label suffix when label is missing', async () => {
        const prompt = await buildAutomationPreamble({
            projectRoot: '/workspace/yoho-task',
        })

        expect(prompt).toContain('mcp__yoho_remote__change_title')
        expect(prompt).not.toContain('（任务定义为：')
    })

    it('does not leak K1 self-system, brain orchestration, skill, or feishu instructions', async () => {
        const prompt = await buildAutomationPreamble({
            projectRoot: '/workspace/yoho-task',
            userName: 'guang@example.com',
            scheduleLabel: 'daily backup',
        })

        // Automation preamble must stay focused — no K1 persona, no brain orchestration,
        // no skill lifecycle rules, no feishu-specific guidance.
        expect(prompt).not.toContain('K1')
        expect(prompt).not.toContain('编排中枢')
        expect(prompt).not.toContain('Brain')
        expect(prompt).not.toContain('skill_list')
        expect(prompt).not.toContain('skill_promote')
        expect(prompt).not.toContain('飞书')
        expect(prompt).not.toContain('selfSystem')
        expect(prompt).not.toContain('feishu')
        expect(prompt).not.toContain('session_find_or_create')
    })
})
