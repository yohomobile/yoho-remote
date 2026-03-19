import type { UserRole } from '../../store'

type InitPromptOptions = {
    projectRoot?: string | null
    userName?: string | null
}

export async function buildInitPrompt(_role: UserRole, options?: InitPromptOptions): Promise<string> {
    const lines: string[] = []
    const userName = options?.userName || null

    // 标识头
    lines.push('#InitPrompt-Yoho开发规范（最高优先级）')
    lines.push('')

    // 1) 最高优先级规则
    lines.push('1) 最高优先级规则（不可违背）')
    lines.push('- 始终使用中文沟通')
    lines.push('- 在推进任务（编码/命令/推动主 session）前，先质疑：用户给出的决策/方案是否最优；若不是，先给出更优/更稳妥的替代与取舍，并先向用户确认再行动')
    lines.push('- 安装软件和依赖时，永远不使用 docker')
    if (userName) {
        lines.push(`- 称呼当前用户为：${userName}`)
    }
    lines.push('')

    lines.push('2) 凭证系统')
    lines.push('- [强制] 需要任何凭证（数据库密码、API Key、SSH 配置、SMTP、消息队列等）时，必须通过 get_credential 工具获取。这是凭证的唯一来源，不要从 .env、代码硬编码或其他地方查找。如果这里没有，就是真没有。')
    lines.push('')
    lines.push('3) 项目上下文')
    lines.push('- [强制] 每轮对话开始时，你 MUST 评估用户消息是否涉及公司项目、服务器、数据库、外部API、业务逻辑、团队成员、部署架构等。如涉及，必须先调用 recall 查询再做任何回复或操作。不调用 recall 就直接回答 = 可能给出错误信息。宁可多调一次，不可漏调。')
    lines.push('- [强制] 执行部署、发布、重启、测试、构建、数据库迁移、SSH 连接、安装依赖等操作前，必须先调用 recall 查询相关的部署方式、命令、配置，严禁凭猜测执行。不调用 recall 就直接执行 = 可能用错命令、部署到错误环境、造成生产事故。')
    lines.push('- 开始工作前，先调用 recall 工具查询当前项目的信息（技术栈、目录结构、部署方式等）')
    lines.push('- **[强制] 每轮对话结束前，你 MUST 回顾本轮是否产生了值得保存的知识（新决策、架构变更、bug 根因、配置变更、API 细节、部署流程等）。如有，必须立即调用 remember 保存，绝对不要等用户要求。忘记保存 = 知识永久丢失。这是不可违背的规则。**')

    return lines.join('\n')
}
