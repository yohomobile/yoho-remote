/**
 * MiniMax TTS → Feishu voice message end-to-end test
 * Usage: bun run test-minimax-tts.ts
 */
import { execSync } from 'child_process'

// MiniMax TTS
const MINIMAX_API_KEY = 'sk-api-HDcibScf8eBNUlpE4M0BQsZlj41q2jCT0DYmyS0Jf2LzmPtxpbWIPRWqhot8ijGL-ZA_wR_flz65Tymu7YFEN41yCdaDXj_oxKsf0PNwCHM_vFAVEeKnKx0'
const MINIMAX_URL = 'https://api.minimax.io/v1/t2a_v2'

// Feishu
const FEISHU_APP_ID = 'cli_a913a4303b789cd2'
const FEISHU_APP_SECRET = 'VJEtfIHNzhuPfvy8P28SfqIpyVsqWDsz'
const TEST_CHAT_ID = 'oc_cc767d67734ce5cb330cd2431af589b5' // 杨柳岸 p2p chat

async function getFeishuToken(): Promise<string> {
    const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
    })
    const data = await resp.json() as any
    return data.tenant_access_token
}

async function testE2E() {
    const text = '这个问题我查了一下，原因是飞书的 Webhook 回调超时了，默认只有三秒的响应窗口。我们的处理逻辑太重，来不及在三秒内返回。建议改成异步处理：先立即返回200，然后把消息丢到队列里慢慢处理。这样既不会超时，也不会丢消息。我现在就改一下，大概十分钟搞定。'

    // Step 1: MiniMax TTS
    console.log(`[1/4] TTS: "${text}"`)
    const t1 = Date.now()
    const ttsResp = await fetch(MINIMAX_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${MINIMAX_API_KEY}`,
        },
        body: JSON.stringify({
            model: 'speech-2.8-hd',
            text,
            stream: false,
            voice_setting: { voice_id: 'English_magnetic_voiced_man', speed: 1 },
            audio_setting: { sample_rate: 16000, format: 'mp3' },
        }),
    })
    const ttsResult = await ttsResp.json() as any
    if (ttsResult.base_resp?.status_code !== 0) {
        console.error('TTS failed:', ttsResult.base_resp)
        return
    }
    const mp3Buf = Buffer.from(ttsResult.data.audio, 'hex')
    const durationMs = ttsResult.extra_info?.audio_length as number
    console.log(`  Done in ${Date.now() - t1}ms, audio ${durationMs}ms, ${(mp3Buf.length / 1024).toFixed(1)}KB mp3`)

    // Step 2: Convert mp3 → opus via ffmpeg
    console.log(`[2/4] Converting mp3 → opus`)
    const t2 = Date.now()
    const mp3Path = '/tmp/hapi-tts-temp.mp3'
    const opusPath = '/tmp/hapi-tts-temp.opus'
    await Bun.write(mp3Path, mp3Buf)
    execSync(`ffmpeg -i ${mp3Path} -acodec libopus -ac 1 -ar 16000 ${opusPath} -y 2>/dev/null`)
    const opusBuf = await Bun.file(opusPath).arrayBuffer()
    console.log(`  Done in ${Date.now() - t2}ms, ${(opusBuf.byteLength / 1024).toFixed(1)}KB opus`)

    // Step 3: Upload opus to Feishu
    console.log(`[3/4] Uploading to Feishu`)
    const t3 = Date.now()
    const token = await getFeishuToken()

    const form = new FormData()
    form.append('file_type', 'opus')
    form.append('file_name', 'voice.opus')
    form.append('duration', String(durationMs))
    form.append('file', new Blob([opusBuf], { type: 'audio/opus' }), 'voice.opus')

    const uploadResp = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: form,
    })
    const uploadResult = await uploadResp.json() as any
    if (uploadResult.code !== 0) {
        console.error('Upload failed:', uploadResult)
        return
    }
    const fileKey = uploadResult.data.file_key
    console.log(`  Done in ${Date.now() - t3}ms, file_key=${fileKey}`)

    // Step 4: Send audio message
    console.log(`[4/4] Sending voice message to ${TEST_CHAT_ID.slice(0, 12)}...`)
    const t4 = Date.now()
    const sendResp = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
            receive_id: TEST_CHAT_ID,
            msg_type: 'audio',
            content: JSON.stringify({ file_key: fileKey }),
        }),
    })
    const sendResult = await sendResp.json() as any
    if (sendResult.code !== 0) {
        console.error('Send failed:', sendResult)
        return
    }
    console.log(`  Done in ${Date.now() - t4}ms`)

    console.log(`\n✅ Total: ${Date.now() - t1}ms`)
}

testE2E().catch(console.error)
