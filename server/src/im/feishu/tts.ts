/**
 * Text-to-Speech module using MiniMax T2A API.
 * Converts text to opus audio buffer for Feishu voice messages.
 */
import { execSync } from 'child_process'
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const MINIMAX_URL = 'https://api.minimax.io/v1/t2a_v2'
const MINIMAX_MODEL = 'speech-2.8-hd'
const MINIMAX_VOICE_ID = 'Chinese (Mandarin)_Reliable_Executive'

let minimaxApiKey: string | null = null

async function getApiKey(): Promise<string> {
    if (minimaxApiKey) return minimaxApiKey
    try {
        // Try reading from credentials file
        const credPath = join(process.env.HOME || '/root', 'happy/yoho-task-v2/data/credentials/minimax/default.json')
        if (existsSync(credPath)) {
            const cred = JSON.parse(readFileSync(credPath, 'utf-8'))
            minimaxApiKey = cred.apiKey
            return minimaxApiKey!
        }
    } catch {}
    throw new Error('MiniMax API key not found')
}

export interface TTSResult {
    opusBuffer: Buffer
    durationMs: number
}

/**
 * Convert text to opus audio using MiniMax TTS + ffmpeg.
 * Returns opus buffer and duration, or null on failure.
 */
export async function textToSpeech(text: string): Promise<TTSResult | null> {
    try {
        const apiKey = await getApiKey()
        const startTime = Date.now()

        // Step 1: MiniMax TTS → mp3
        const resp = await fetch(MINIMAX_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: MINIMAX_MODEL,
                text,
                stream: false,
                voice_setting: { voice_id: MINIMAX_VOICE_ID, speed: 1 },
                audio_setting: { sample_rate: 16000, format: 'mp3' },
            }),
        })

        const result = await resp.json() as any
        if (result.base_resp?.status_code !== 0) {
            console.error(`[TTS] MiniMax API error: code=${result.base_resp?.status_code}, msg=${result.base_resp?.status_msg}`)
            return null
        }

        const hexAudio = result.data?.audio as string
        if (!hexAudio) {
            console.error(`[TTS] No audio data in MiniMax response`)
            return null
        }

        const mp3Buffer = Buffer.from(hexAudio, 'hex')
        const durationMs = result.extra_info?.audio_length as number || 0

        // Step 2: mp3 → opus via ffmpeg
        const ts = Date.now()
        const mp3Path = join(tmpdir(), `yr-tts-${ts}.mp3`)
        const opusPath = join(tmpdir(), `yr-tts-${ts}.opus`)

        writeFileSync(mp3Path, mp3Buffer)
        execSync(`ffmpeg -i "${mp3Path}" -acodec libopus -ac 1 -ar 16000 "${opusPath}" -y 2>/dev/null`)
        const opusBuffer = readFileSync(opusPath)

        // Cleanup temp files
        try { unlinkSync(mp3Path) } catch {}
        try { unlinkSync(opusPath) } catch {}

        console.log(`[TTS] Generated ${durationMs}ms audio (${(opusBuffer.length / 1024).toFixed(1)}KB) in ${Date.now() - startTime}ms`)
        return { opusBuffer, durationMs }
    } catch (err) {
        console.error(`[TTS] textToSpeech failed:`, err)
        return null
    }
}
