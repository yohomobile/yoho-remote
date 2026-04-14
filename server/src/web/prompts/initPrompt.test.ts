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
    })

    it('renders shared-directory guidance without worktree instructions', async () => {
        const prompt = await buildInitPrompt('developer', {
            projectRoot: '/vm/shared/yoho-remote'
        })

        expect(prompt).toContain('当前会话工作目录：/vm/shared/yoho-remote')
        expect(prompt).toContain('共享代码目录（path），默认按组织共享')
        expect(prompt).not.toContain('所有查看、编辑、测试、提交都必须在当前会话目录进行')
        expect(prompt).not.toContain('Git worktree')
    })

    it('uses the same shared-directory rules in brain init prompts', async () => {
        const prompt = await buildBrainInitPrompt('developer', {
            projectRoot: '/vm/shared/yoho-remote'
        })

        expect(prompt).toContain('当前会话工作目录：/vm/shared/yoho-remote')
        expect(prompt).not.toContain('Git worktree')
        expect(prompt).not.toContain('部署 dev 必须先合入 dev-release')
        expect(prompt).not.toContain('部署线上必须先合入 main')
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
})
