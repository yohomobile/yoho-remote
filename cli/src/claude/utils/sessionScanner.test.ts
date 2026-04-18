import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSessionScanner } from './sessionScanner'
import { RawJSONLines } from '../types'
import { mkdir, writeFile, appendFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { existsSync } from 'node:fs'

function getMessageContent(message: RawJSONLines): unknown {
  if (!('message' in message) || !message.message || typeof message.message !== 'object') {
    return undefined
  }
  return (message.message as { content?: unknown }).content
}

describe('sessionScanner', () => {
  let testDir: string
  let projectDir: string
  let collectedMessages: RawJSONLines[]
  let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null
  
  beforeEach(async () => {
    testDir = join(tmpdir(), `scanner-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
    
    const projectName = testDir.replace(/\//g, '-')
    projectDir = join(homedir(), '.claude', 'projects', projectName)
    await mkdir(projectDir, { recursive: true })
    
    collectedMessages = []
  })
  
  afterEach(async () => {
    // Clean up scanner
    if (scanner) {
      await scanner.cleanup()
      scanner = null
    }
    
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
    if (existsSync(projectDir)) {
      await rm(projectDir, { recursive: true, force: true })
    }
  })
  
  it('should process initial session and resumed session correctly', async () => {
    // TEST SCENARIO:
    // Phase 1: User says "lol" → Assistant responds "lol" → Session closes
    // Phase 2: User resumes with NEW session ID → User says "run ls tool" → Assistant runs LS tool → Shows files
    // 
    // Key point: When resuming, Claude creates a NEW session file with:
    // - Summary line
    // - Complete history from previous session (with NEW session ID)
    // - New messages
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg)
    })
    
    // PHASE 1: Initial session (0-say-lol-session.jsonl)
    const fixture1 = await readFile(join(__dirname, '__fixtures__', '0-say-lol-session.jsonl'), 'utf-8')
    const lines1 = fixture1.split('\n').filter(line => line.trim())
    
    const sessionId1 = '93a9705e-bc6a-406d-8dce-8acc014dedbd'
    const sessionFile1 = join(projectDir, `${sessionId1}.jsonl`)
    
    // Write first line
    await writeFile(sessionFile1, lines1[0] + '\n')
    scanner.onNewSession(sessionId1)
    await new Promise(resolve => setTimeout(resolve, 100))
    
    expect(collectedMessages).toHaveLength(1)
    expect(collectedMessages[0].type).toBe('user')
    if (collectedMessages[0].type === 'user') {
      const content = getMessageContent(collectedMessages[0])
      const text = typeof content === 'string' ? content : (content as any)[0].text
      expect(text).toBe('say lol')
    }
    
    // Write second line with delay
    await new Promise(resolve => setTimeout(resolve, 50))
    await appendFile(sessionFile1, lines1[1] + '\n')
    await new Promise(resolve => setTimeout(resolve, 200))
    
    expect(collectedMessages).toHaveLength(2)
    expect(collectedMessages[1].type).toBe('assistant')
    if (collectedMessages[1].type === 'assistant') {
      expect((getMessageContent(collectedMessages[1]) as any)[0].text).toBe('lol')
    }
    
    // PHASE 2: Resumed session (1-continue-run-ls-tool.jsonl)
    const fixture2 = await readFile(join(__dirname, '__fixtures__', '1-continue-run-ls-tool.jsonl'), 'utf-8')
    const lines2 = fixture2.split('\n').filter(line => line.trim())
    
    const sessionId2 = '789e105f-ae33-486d-9271-0696266f072d'
    const sessionFile2 = join(projectDir, `${sessionId2}.jsonl`)
    
    // Reset collected messages count for clarity
    const phase1Count = collectedMessages.length
    
    // Write summary + historical messages (lines 0-2) - NOT line 3 which is new
    let initialContent = ''
    for (let i = 0; i <= 2; i++) {
      initialContent += lines2[i] + '\n'
    }
    await writeFile(sessionFile2, initialContent)
    
    scanner.onNewSession(sessionId2)
    await new Promise(resolve => setTimeout(resolve, 100))
    
    // Should have added only 1 new message (summary) 
    // The historical user + assistant messages (lines 1-2) are deduplicated because they have same UUIDs
    expect(collectedMessages).toHaveLength(phase1Count + 1)
    expect(collectedMessages[phase1Count].type).toBe('summary')
    
    // Write new messages (user asks for ls tool) - this is line 3
    await new Promise(resolve => setTimeout(resolve, 50))
    await appendFile(sessionFile2, lines2[3] + '\n')
    await new Promise(resolve => setTimeout(resolve, 200))
    
    // Find the user message we just added
    const userMessages = collectedMessages.filter(m => m.type === 'user')
    const lastUserMsg = userMessages[userMessages.length - 1]
    expect(lastUserMsg).toBeDefined()
    if (lastUserMsg && lastUserMsg.type === 'user') {
      expect(getMessageContent(lastUserMsg)).toBe('run ls tool ')
    }
    
    // Write remaining lines (assistant tool use, tool result, final assistant message) - starting from line 4
    for (let i = 4; i < lines2.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      await appendFile(sessionFile2, lines2[i] + '\n')
    }
    await new Promise(resolve => setTimeout(resolve, 300))
    
    // Final count check
    const finalMessages = collectedMessages.slice(phase1Count)
    
    // Should have: 1 summary + 0 history (deduplicated) + 4 new messages = 5 total for session 2
    expect(finalMessages.length).toBeGreaterThanOrEqual(5)
    
    // Verify last message is assistant with the file listing
    const lastAssistantMsg = collectedMessages[collectedMessages.length - 1]
    expect(lastAssistantMsg.type).toBe('assistant')
    if (lastAssistantMsg.type === 'assistant') {
      const content = (getMessageContent(lastAssistantMsg) as any)[0].text
      expect(content).toContain('0-say-lol-session.jsonl')
      expect(content).toContain('readme.md')
    }
  })

  it('silently skips Claude metadata lines that would otherwise duplicate or spam the timeline', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg)
    })

    const sessionId = 'metadata-filter-session'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)
    const lines = [
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        timestamp: '2026-04-17T00:00:00.000Z',
        message: { content: 'hello' }
      }),
      JSON.stringify({
        type: 'last-prompt',
        sessionId,
        lastPrompt: 'hello'
      }),
      JSON.stringify({
        type: 'permission-mode',
        sessionId,
        permissionMode: 'default'
      }),
      JSON.stringify({
        type: 'attachment',
        uuid: 'attachment-1',
        timestamp: '2026-04-17T00:00:01.000Z',
        attachment: {
          type: 'skill_listing',
          content: '- test-skill'
        }
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: '2026-04-17T00:00:02.000Z',
        message: {
          content: [{ type: 'text', text: 'pong' }]
        }
      })
    ].join('\n') + '\n'

    await writeFile(sessionFile, lines)
    scanner.onNewSession(sessionId)
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(collectedMessages).toHaveLength(2)
    expect(collectedMessages.map((msg) => msg.type)).toEqual(['user', 'assistant'])
  })

  it('keeps plan attachments like plan_mode and todo_reminder in the scanned message stream', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg)
    })

    const sessionId = 'plan-filter-session'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)
    const lines = [
      JSON.stringify({
        type: 'attachment',
        uuid: 'attachment-plan-mode',
        timestamp: '2026-04-17T00:00:00.000Z',
        attachment: {
          type: 'plan_mode',
          planFilePath: '/tmp/demo-plan.md',
          planExists: false
        }
      }),
      JSON.stringify({
        type: 'attachment',
        uuid: 'attachment-todo',
        timestamp: '2026-04-17T00:00:01.000Z',
        attachment: {
          type: 'todo_reminder',
          itemCount: 1,
          content: [{
            content: 'Review the plan',
            status: 'in_progress',
            activeForm: 'Reviewing the plan'
          }]
        }
      })
    ].join('\n') + '\n'

    await writeFile(sessionFile, lines)
    scanner.onNewSession(sessionId)
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(collectedMessages).toHaveLength(2)
    expect(collectedMessages.map((msg) => msg.type)).toEqual(['attachment', 'attachment'])
  })

  it('keeps same-timestamp Claude semantic events distinct without uuid', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg)
    })

    const sessionId = 'semantic-key-session'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)
    const timestamp = '2026-04-17T00:00:00.000Z'
    const lines = [
      JSON.stringify({ type: 'result', request_id: 'req-1', session_id: sessionId, result: 'done-1', timestamp }),
      JSON.stringify({ type: 'result', request_id: 'req-2', session_id: sessionId, result: 'done-2', timestamp }),
      JSON.stringify({ type: 'progress', step_id: 'step-1', progress: 10, timestamp }),
      JSON.stringify({ type: 'progress', step_id: 'step-2', progress: 20, timestamp }),
      JSON.stringify({ type: 'rate_limit_event', limit_type: 'requests', remaining: 3, timestamp }),
      JSON.stringify({ type: 'rate_limit_event', limit_type: 'tokens', remaining: 2, timestamp }),
      JSON.stringify({ type: 'tool_progress', tool_use_id: 'tool-1', seq: 1, timestamp }),
      JSON.stringify({ type: 'tool_progress', tool_use_id: 'tool-1', seq: 2, timestamp })
    ].join('\n') + '\n'

    await writeFile(sessionFile, lines)
    scanner.onNewSession(sessionId)
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(collectedMessages).toHaveLength(8)
    expect(collectedMessages.map((msg) => msg.type)).toEqual([
      'result',
      'result',
      'progress',
      'progress',
      'rate_limit_event',
      'rate_limit_event',
      'tool_progress',
      'tool_progress'
    ])
  })

  it('keeps distinct unknown Claude payloads with identical timestamps from collapsing', async () => {
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg)
    })

    const sessionId = 'unknown-hash-session'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)
    const timestamp = '2026-04-17T00:00:00.000Z'
    const lines = [
      JSON.stringify({
        type: 'custom_event',
        request_id: 'req-a',
        timestamp,
        detail: { step: 'one', status: 'running' }
      }),
      JSON.stringify({
        type: 'custom_event',
        request_id: 'req-b',
        timestamp,
        detail: { step: 'two', status: 'running' }
      })
    ].join('\n') + '\n'

    await writeFile(sessionFile, lines)
    scanner.onNewSession(sessionId)
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(collectedMessages).toHaveLength(2)
    expect(collectedMessages.map((msg) => msg.type)).toEqual(['custom_event', 'custom_event'])
  })

  it('skips pre-clear messages after a session clear signal but still emits newer ones', async () => {
    const sessionId = 'session-clear-cache'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)
    const oldTimestamp = '2026-04-17T00:00:00.000Z'

    await writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: 'user',
          sessionId,
          uuid: 'user-before-clear',
          timestamp: oldTimestamp,
          message: {
            role: 'user',
            content: 'before clear'
          }
        })
      ].join('\n') + '\n'
    )

    scanner = await createSessionScanner({
      sessionId,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg)
    })

    await new Promise(resolve => setTimeout(resolve, 150))
    expect(collectedMessages).toHaveLength(0)

    scanner.clearSessionCache(sessionId, Date.parse('2026-04-17T00:00:02.000Z'))

    await appendFile(
      sessionFile,
      JSON.stringify({
        type: 'user',
        sessionId,
        uuid: 'user-after-clear-old',
        timestamp: oldTimestamp,
        message: {
          role: 'user',
          content: 'after clear but old timestamp'
        }
      }) + '\n'
    )
    await appendFile(
      sessionFile,
      JSON.stringify({
        type: 'user',
        sessionId,
        uuid: 'user-after-clear-new',
        timestamp: '2026-04-17T00:00:05.000Z',
        message: {
          role: 'user',
          content: 'after clear and new timestamp'
        }
      }) + '\n'
    )

    await new Promise(resolve => setTimeout(resolve, 250))

    expect(collectedMessages).toHaveLength(1)
    expect(collectedMessages[0]).toMatchObject({
      uuid: 'user-after-clear-new',
      message: {
        role: 'user',
        content: 'after clear and new timestamp'
      }
    })
  })
})
