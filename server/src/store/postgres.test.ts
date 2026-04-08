import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./postgres.ts', import.meta.url), 'utf8')

describe('PostgresStore schema migrations', () => {
    it('adds project scope columns before creating dependent indexes', () => {
        const addMachineId = source.indexOf('ALTER TABLE projects ADD COLUMN IF NOT EXISTS machine_id TEXT;')
        const addWorkspaceGroupId = source.indexOf('ALTER TABLE projects ADD COLUMN IF NOT EXISTS workspace_group_id TEXT;')
        const createMachineIdIndex = source.indexOf('CREATE INDEX IF NOT EXISTS idx_projects_machine_id ON projects(machine_id);')
        const createWorkspaceGroupIdIndex = source.indexOf('CREATE INDEX IF NOT EXISTS idx_projects_workspace_group_id ON projects(workspace_group_id);')

        expect(addMachineId).toBeGreaterThan(-1)
        expect(addWorkspaceGroupId).toBeGreaterThan(-1)
        expect(createMachineIdIndex).toBeGreaterThan(-1)
        expect(createWorkspaceGroupIdIndex).toBeGreaterThan(-1)

        expect(addMachineId).toBeLessThan(createMachineIdIndex)
        expect(addWorkspaceGroupId).toBeLessThan(createWorkspaceGroupIdIndex)
    })
})
