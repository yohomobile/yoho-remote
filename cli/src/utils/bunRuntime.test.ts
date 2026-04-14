import { describe, expect, it } from 'bun:test'
import { delimiter, join } from 'node:path'

import { ensureBunBinPath } from './bunRuntime'

describe('ensureBunBinPath', () => {
    it('prepends ~/.bun/bin when PATH is missing it', () => {
        const homeDir = '/tmp/test-home'
        const bunBinDir = join(homeDir, '.bun', 'bin')
        const originalEnv = {
            HOME: homeDir,
            PATH: ['/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
        }

        const nextEnv = ensureBunBinPath(originalEnv, {
            homeDir,
            pathExists: path => path === bunBinDir,
        })

        expect(nextEnv.PATH).toBe(
            [bunBinDir, '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter)
        )
    })

    it('does not duplicate ~/.bun/bin when it is already present', () => {
        const homeDir = '/tmp/test-home'
        const bunBinDir = join(homeDir, '.bun', 'bin')
        const originalEnv = {
            HOME: homeDir,
            PATH: [bunBinDir, '/usr/local/bin', '/usr/bin'].join(delimiter),
        }

        const nextEnv = ensureBunBinPath(originalEnv, {
            homeDir,
            pathExists: path => path === bunBinDir,
        })

        expect(nextEnv).toBe(originalEnv)
    })

    it('leaves PATH unchanged when ~/.bun/bin does not exist', () => {
        const originalEnv = {
            HOME: '/tmp/test-home',
            PATH: ['/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
        }

        const nextEnv = ensureBunBinPath(originalEnv, {
            homeDir: '/tmp/test-home',
            pathExists: () => false,
        })

        expect(nextEnv).toBe(originalEnv)
    })
})
