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
        // 部署规则现在在 section 5 开发规范中
        expect(prompt).toContain('部署 dev 环境前，必须确认代码已合入 `dev-release`')
        expect(prompt).toContain('部署线上环境前，必须确认代码已合入 `main`')
        expect(prompt).toContain('如果当前改动只存在于个人开发分支 / feature 分支，先合并到目标发布分支，再执行部署')
    })

    it('renders shared-directory guidance without worktree instructions', async () => {
        const prompt = await buildInitPrompt('developer', {
            projectRoot: '/vm/shared/yoho-remote'
        })

        expect(prompt).toContain('当前会话工作目录：/vm/shared/yoho-remote')
        expect(prompt).toContain('共享代码目录（path），默认按组织共享')
        expect(prompt).toContain('所有查看、编辑、测试、提交都必须在当前会话目录进行')
        expect(prompt).not.toContain('Git worktree')
    })

    it('uses the same shared-directory rules in brain init prompts', async () => {
        const prompt = await buildBrainInitPrompt('developer', {
            projectRoot: '/vm/shared/yoho-remote'
        })

        expect(prompt).toContain('当前会话工作目录：/vm/shared/yoho-remote')
        expect(prompt).not.toContain('Git worktree')
        expect(prompt).toContain('部署 dev 必须先合入 dev-release')
        expect(prompt).toContain('部署线上必须先合入 main')
    })
})
