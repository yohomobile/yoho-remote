import { describe, expect, it } from 'bun:test'
import { buildBrainInitPrompt, buildInitPrompt } from './initPrompt'

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
        expect(prompt).toContain('mcp__skill__list')
        expect(prompt).toContain('skill_search')
        expect(prompt).toContain('方法/能力类 skill')
        expect(prompt).toContain('activationMode=manual')
        expect(prompt).toContain('candidate / draft / archived / disabled')
        expect(prompt).toContain('skill_promote')
        expect(prompt).toContain('skill_doctor')
        expect(prompt).toContain('allowActive=true')
        expect(prompt).toContain('skill_discover')
    })

    it('renders machine-local project guidance without worktree instructions', async () => {
        const prompt = await buildInitPrompt('developer', {
            projectRoot: '/vm/shared/yoho-remote'
        })

        expect(prompt).toContain('当前会话工作目录：/vm/shared/yoho-remote')
        expect(prompt).toContain('绑定到具体机器')
        expect(prompt).not.toContain('所有查看、编辑、测试、提交都必须在当前会话目录进行')
        expect(prompt).not.toContain('Git worktree')
        expect(prompt).toContain('mcp__yoho-vault__recall')
        expect(prompt).toContain('mcp__yoho-memory__remember')
        expect(prompt).toContain('不要因为有相似关键词就硬套 skill')
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
        expect(prompt).toContain('mcp__skill__list')
        expect(prompt).toContain('skill_search')
        expect(prompt).toContain('activationMode=manual')
        expect(prompt).toContain('candidate / draft / archived / disabled')
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
