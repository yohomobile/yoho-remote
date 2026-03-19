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
    lines.push('')
    lines.push('4) Playbook 行动指南（步进器模式）— 不可违背')
    lines.push('- [强制] 完成以下任何一类任务后，MUST 调用 `get_playbook` 启动行动指南：')
    lines.push('  - 代码变更（新功能、bug 修复、重构、CSS/样式、API 新增/修改）')
    lines.push('  - 基础设施操作（部署、数据库迁移、配置变更、安全相关、性能优化）')
    lines.push('  - 手动操作流程（需要多步协调的运维/业务操作）')
    lines.push('- 传参：`scenario` 和 `summary` 必须同时传。scenario 指定场景类型，summary 描述具体做了什么。')
    lines.push('- [强制] summary 必须事无巨细：写明改了哪些文件、哪些组件/函数、改动类型、影响范围、技术方案。越详细越精准。')
    lines.push('  - 禁止笼统 summary："修改了代码" "修了个bug" "改了样式" — 全部不合格')
    lines.push('- get_playbook 是步进器：每次只返回一步。执行完后调用 `get_playbook({ run_id: "xxx", result: "done" })` 获取下一步。循环直到 status="done"。')
    lines.push('- [auto] 步骤：直接执行，完成后传 result: "done"。[confirm] 步骤：展示给用户确认后传 result: "confirmed"。不适用传 result: "skipped"。')
    lines.push('- [强制] 严禁跳步、严禁口头过一遍就结束。每一步都必须有实际的工具调用作为执行证据。')
    lines.push('- 发现缺少重要步骤或检查项时，调用 `learn_playbook` 沉淀经验。')
    lines.push('')

    return lines.join('\n')
}
