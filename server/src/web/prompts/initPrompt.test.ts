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
        expect(prompt).toContain('如果当前改动只存在于 worktree / feature 分支，先合并到目标发布分支，再执行部署')
    })

    it('explains how to work inside a worktree session', async () => {
        const prompt = await buildInitPrompt('developer', {
            projectRoot: '/vm/shared/yoho-remote-worktrees/guang_yang',
            worktree: {
                basePath: '/vm/shared/yoho-remote',
                worktreePath: '/vm/shared/yoho-remote-worktrees/guang_yang',
                branch: 'yr-guang_yang',
                name: 'guang_yang'
            }
        })

        expect(prompt).toContain('当前会话工作目录：/vm/shared/yoho-remote-worktrees/guang_yang')
        expect(prompt).toContain('当前会话基仓库目录：/vm/shared/yoho-remote')
        expect(prompt).toContain('当前会话使用 Git worktree 隔离开发：名称 guang_yang，分支 yr-guang_yang，路径 /vm/shared/yoho-remote-worktrees/guang_yang')
        expect(prompt).toContain('所有查看、编辑、测试、提交都必须在当前 worktree 目录进行')
        expect(prompt).toContain('除非用户明确要求，否则禁止回到基仓库目录直接改文件、运行提交或清理操作')
        expect(prompt).toContain('任何代码修改都必须以 worktreePath 为准')
    })

    it('includes the same worktree rules in brain init prompts', async () => {
        const prompt = await buildBrainInitPrompt('developer', {
            projectRoot: '/vm/shared/yoho-remote-worktrees/guang_yang',
            worktree: {
                basePath: '/vm/shared/yoho-remote',
                worktreePath: '/vm/shared/yoho-remote-worktrees/guang_yang',
                branch: 'yr-guang_yang',
                name: 'guang_yang'
            }
        })

        expect(prompt).toContain('当前会话基仓库目录：/vm/shared/yoho-remote')
        expect(prompt).toContain('当前会话使用 Git worktree 隔离开发：名称 guang_yang，分支 yr-guang_yang，路径 /vm/shared/yoho-remote-worktrees/guang_yang')
        // worktree 行为规则在 brain prompt 中以精简形式出现在规则部分
        expect(prompt).toContain('部署 dev 必须先合入 dev-release')
        expect(prompt).toContain('部署线上必须先合入 main')
    })
})
