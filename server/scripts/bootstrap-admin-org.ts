import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { PostgresStore } from '../src/store/postgres'

type Args = {
    orgId?: string
    slug?: string
    envFile?: string
}

function parseArgs(argv: string[]): Args {
    const args: Args = {}
    for (let index = 0; index < argv.length; index++) {
        const current = argv[index]
        const next = argv[index + 1]
        if ((current === '--id' || current === '--org-id') && next) {
            args.orgId = next
            index++
            continue
        }
        if (current === '--slug' && next) {
            args.slug = next
            index++
            continue
        }
        if (current === '--env-file' && next) {
            args.envFile = next
            index++
            continue
        }
        if (current === '--help' || current === '-h') {
            printHelp()
            process.exit(0)
        }
        throw new Error(`Unknown or incomplete argument: ${current}`)
    }
    if (!args.orgId && !args.slug) {
        throw new Error('Provide --id <orgId> or --slug <slug>')
    }
    return args
}

function printHelp(): void {
    console.log(`Usage:
  bun run bootstrap:admin-org -- --slug <slug> [--env-file <path>]
  bun run bootstrap:admin-org -- --id <orgId> [--env-file <path>]

Examples:
  bun run bootstrap:admin-org -- --slug platform-admin --env-file /etc/yoho-remote/server.env
  bun run bootstrap:admin-org -- --id org_123456
`)
}

function upsertEnvLine(content: string, key: string, value: string): string {
    const line = `${key}=${value}`
    if (new RegExp(`^${key}=`, 'm').test(content)) {
        return content.replace(new RegExp(`^${key}=.*$`, 'm'), line)
    }
    const trimmed = content.trimEnd()
    return trimmed ? `${trimmed}\n${line}\n` : `${line}\n`
}

async function main() {
    const args = parseArgs(process.argv.slice(2))
    const store = await PostgresStore.create({
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT || '5432', 10),
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || '',
        database: process.env.PG_DATABASE || 'yoho_remote',
        ssl: process.env.PG_SSL === 'true',
    })

    try {
        const org = args.orgId
            ? await store.getOrganization(args.orgId)
            : await store.getOrganizationBySlug(args.slug!)

        if (!org) {
            throw new Error('Organization not found')
        }

        console.log(`Resolved organization:`)
        console.log(`  Name: ${org.name}`)
        console.log(`  Slug: ${org.slug}`)
        console.log(`  ID:   ${org.id}`)

        if (args.envFile) {
            const envFile = resolve(args.envFile)
            if (!existsSync(dirname(envFile))) {
                mkdirSync(dirname(envFile), { recursive: true })
            }
            const current = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''
            const next = upsertEnvLine(current, 'ADMIN_ORG_ID', org.id)
            writeFileSync(envFile, next)
            console.log(``)
            console.log(`Updated ${envFile}`)
            console.log(`Next steps:`)
            console.log(`  1. Restart yoho-remote-server`)
            console.log(`  2. Sign in to the admin org in Settings`)
            console.log(`  3. Use the License Admin panel to issue customer licenses`)
            return
        }

        console.log(``)
        console.log(`Export or persist this value before restarting the server:`)
        console.log(`  ADMIN_ORG_ID=${org.id}`)
    } finally {
        await store.close()
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
