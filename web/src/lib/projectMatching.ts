import type { Project } from '@/types/api'

type SessionProjectMetadata = {
    path: string
    machineId?: string
    worktree?: {
        basePath: string
    }
}

type SessionLike = {
    metadata: SessionProjectMetadata | null
}

function getSessionPath(session: SessionLike): string | null {
    return session.metadata?.worktree?.basePath ?? session.metadata?.path ?? null
}

export function matchSessionToProject(session: SessionLike, projects: Project[]): Project | null {
    const sessionPath = getSessionPath(session)
    const sessionMachineId = session.metadata?.machineId?.trim() || null
    if (!sessionPath || !sessionMachineId) return null
    if (!Array.isArray(projects)) return null

    const machineProjects = projects.filter((project) => project.machineId === sessionMachineId)

    for (const project of machineProjects) {
        if (project.path === sessionPath) {
            return project
        }
    }

    for (const project of machineProjects) {
        if (sessionPath.startsWith(project.path + '/') || sessionPath.startsWith(project.path + '-')) {
            return project
        }
    }

    return null
}
