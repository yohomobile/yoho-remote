import { useCallback, useEffect, useRef, useState } from 'react'

type SpeechToTextStatus = 'idle' | 'connecting' | 'recording' | 'stopping' | 'error'

type SpeechToTextOptions = {
    onPartial: (text: string) => void
    onFinal: (text: string) => void
    onError?: (message: string) => void
    wsUrl?: string
}

const TARGET_SAMPLE_RATE = 16000
const CHUNK_DURATION_MS = 300
const CHUNK_SAMPLES = Math.floor(TARGET_SAMPLE_RATE * (CHUNK_DURATION_MS / 1000))
const PROCESSOR_BUFFER_SIZE = 4096
const INPUT_GAIN = 4
const VOLUME_DB_FLOOR = 60
const VOLUME_DB_EPSILON = 0.0001
const VOLUME_SMOOTHING = 0.7

const DEFAULT_WS_URL = 'wss://whisper.yohomobile.dev'

function getAudioContextCtor(): typeof AudioContext | null {
    if (typeof window === 'undefined') return null
    const anyWindow = window as typeof window & { webkitAudioContext?: typeof AudioContext }
    return window.AudioContext ?? anyWindow.webkitAudioContext ?? null
}

function resampleToTarget(input: Float32Array, sourceRate: number): Float32Array {
    if (sourceRate === TARGET_SAMPLE_RATE) return input
    const ratio = sourceRate / TARGET_SAMPLE_RATE
    const newLength = Math.max(1, Math.round(input.length / ratio))
    const output = new Float32Array(newLength)
    for (let i = 0; i < newLength; i += 1) {
        const position = i * ratio
        const index = Math.floor(position)
        const nextIndex = Math.min(index + 1, input.length - 1)
        const weight = position - index
        output[i] = input[index] + (input[nextIndex] - input[index]) * weight
    }
    return output
}

function getClientUid(): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
    const length = 16
    if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
        const bytes = new Uint8Array(length)
        crypto.getRandomValues(bytes)
        let result = ''
        for (let i = 0; i < length; i += 1) {
            result += alphabet[bytes[i] % alphabet.length]
        }
        return result
    }
    let result = ''
    for (let i = 0; i < length; i += 1) {
        const idx = Math.floor(Math.random() * alphabet.length)
        result += alphabet[idx]
    }
    return result
}

type WhisperSegment = {
    start: number
    end: number
    text: string
    completed?: boolean
}

type WhisperPayload = {
    message?: string
    backend?: string
    segments?: WhisperSegment[]
    text?: string
    partial?: string
    result?: string
    is_final?: boolean
    final?: boolean
}

type WhisperMessage = WhisperPayload & {
    uid?: string
    data?: WhisperPayload
}

export function useSpeechToText(options: SpeechToTextOptions) {
    const [status, setStatus] = useState<SpeechToTextStatus>('idle')
    const [error, setError] = useState<string | null>(null)
    const [volume, setVolume] = useState(0)

    const onPartialRef = useRef(options.onPartial)
    const onFinalRef = useRef(options.onFinal)
    const onErrorRef = useRef(options.onError)
    const wsUrlRef = useRef(options.wsUrl ?? DEFAULT_WS_URL)

    const audioContextRef = useRef<AudioContext | null>(null)
    const mediaStreamRef = useRef<MediaStream | null>(null)
    const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
    const processorRef = useRef<ScriptProcessorNode | null>(null)
    const gainRef = useRef<GainNode | null>(null)
    const preparedRef = useRef(false)
    const capturingRef = useRef(false)
    const volumeRef = useRef(0)

    const wsRef = useRef<WebSocket | null>(null)
    const clientUidRef = useRef('')
    const sampleBufferRef = useRef<number[]>([])
    const stoppingRef = useRef(false)
    const startAttemptRef = useRef(0)
    const lastTextRef = useRef('')
    const completedTextRef = useRef<string[]>([])

    useEffect(() => {
        onPartialRef.current = options.onPartial
    }, [options.onPartial])

    useEffect(() => {
        onFinalRef.current = options.onFinal
    }, [options.onFinal])

    useEffect(() => {
        onErrorRef.current = options.onError
    }, [options.onError])

    useEffect(() => {
        wsUrlRef.current = options.wsUrl ?? DEFAULT_WS_URL
    }, [options.wsUrl])

    const cleanupWebSocket = useCallback(() => {
        if (wsRef.current) {
            wsRef.current.close()
            wsRef.current = null
        }
    }, [])

    const cleanupAudio = useCallback(() => {
        processorRef.current?.disconnect()
        sourceRef.current?.disconnect()
        gainRef.current?.disconnect()

        processorRef.current = null
        sourceRef.current = null
        gainRef.current = null

        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(track => track.stop())
        }
        mediaStreamRef.current = null

        if (audioContextRef.current) {
            audioContextRef.current.close().catch(() => {})
        }
        audioContextRef.current = null
    }, [])

    const resetStreamState = useCallback(() => {
        sampleBufferRef.current = []
        capturingRef.current = false
        stoppingRef.current = false
        clientUidRef.current = ''
        volumeRef.current = 0
        lastTextRef.current = ''
        completedTextRef.current = []
        setVolume(0)
    }, [])

    const handleError = useCallback((message: string) => {
        setError(message)
        setStatus('error')
        cleanupWebSocket()
        cleanupAudio()
        preparedRef.current = false
        resetStreamState()
        onErrorRef.current?.(message)
    }, [cleanupWebSocket, cleanupAudio, resetStreamState])

    const chunkCountRef = useRef(0)

    const sendAudioChunkRef = useRef((audio: Float32Array) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            console.log('[stt] sendAudioChunk skipped - ws not ready', {
                hasWs: Boolean(wsRef.current),
                readyState: wsRef.current?.readyState
            })
            return
        }
        // Apply gain and send as Float32 (WhisperLive expects float32 normalized audio)
        const float32 = new Float32Array(audio.length)
        for (let i = 0; i < audio.length; i++) {
            float32[i] = Math.max(-1, Math.min(1, (audio[i] ?? 0) * INPUT_GAIN))
        }
        chunkCountRef.current += 1
        if (chunkCountRef.current <= 5 || chunkCountRef.current % 50 === 0) {
            console.log('[stt] sendAudioChunk', {
                chunkNum: chunkCountRef.current,
                samples: float32.length,
                byteLength: float32.buffer.byteLength,
                sampleMin: Math.min(...float32),
                sampleMax: Math.max(...float32)
            })
        }
        wsRef.current.send(float32.buffer)
    })

    // Use ref to track status for WebSocket callbacks (avoid stale closure)
    const statusRef = useRef(status)
    useEffect(() => {
        statusRef.current = status
    }, [status])

    const handleWebSocketPayload = useCallback((payloadText: string, allowPlainText: boolean) => {
        let data: WhisperMessage
        try {
            data = JSON.parse(payloadText) as WhisperMessage
        } catch (err) {
            if (allowPlainText) {
                // Only process text results when recording
                if (statusRef.current !== 'recording' && statusRef.current !== 'stopping') {
                    console.log('[stt] ignoring plain text - not recording', statusRef.current)
                    return
                }
                const fallback = payloadText.trim()
                if (fallback) {
                    completedTextRef.current = []
                    lastTextRef.current = fallback
                    onPartialRef.current(fallback)
                }
                return
            }
            console.error('[stt] ws message parse error', err)
            return
        }

        console.log('[stt] ws message', data)

        const payload = data.data ?? data
        const message = payload.message ?? data.message
        const backend = payload.backend ?? data.backend

        if (message === 'SERVER_READY') {
            console.log('[stt] server ready, backend:', backend)
            return
        }

        if (message === 'DISCONNECT') {
            console.log('[stt] server disconnect')
            if (statusRef.current === 'recording' || statusRef.current === 'stopping') {
                // Collect final text
                const finalText = [...completedTextRef.current, lastTextRef.current].join('').trim()
                if (finalText) {
                    onFinalRef.current(finalText)
                }
                setStatus('idle')
            }
            cleanupWebSocket()
            return
        }

        // Only process transcription results when recording or stopping
        if (statusRef.current !== 'recording' && statusRef.current !== 'stopping') {
            console.log('[stt] ignoring transcription result - not recording', statusRef.current)
            return
        }

        const segments = Array.isArray(payload.segments)
            ? payload.segments
            : Array.isArray(data.segments)
                ? data.segments
                : null

        if (segments && segments.length > 0) {
            console.log('[stt] processing segments:', segments)
            const hasCompletionFlag = segments.some(seg => seg.completed !== undefined)

            if (hasCompletionFlag) {
                // Process segments with completion flags
                const newCompleted: string[] = []
                let currentText = ''

                for (const seg of segments) {
                    if (seg.completed) {
                        newCompleted.push(seg.text)
                    } else {
                        currentText = seg.text
                    }
                }

                // Update completed segments
                if (newCompleted.length > 0) {
                    completedTextRef.current = newCompleted
                }

                lastTextRef.current = currentText

                // Build full text for partial callback
                const fullText = [...completedTextRef.current, currentText].join('').trim()
                if (fullText) {
                    console.log('[stt] calling onPartial with segments text:', fullText)
                    onPartialRef.current(fullText)
                }
                return
            }

            const fullText = segments.map(seg => seg.text).join('').trim()
            if (fullText) {
                console.log('[stt] calling onPartial with joined segments:', fullText)
                completedTextRef.current = []
                lastTextRef.current = fullText
                onPartialRef.current(fullText)
            }
            return
        }

        const text = typeof payload.text === 'string'
            ? payload.text
            : typeof payload.partial === 'string'
                ? payload.partial
                : typeof payload.result === 'string'
                    ? payload.result
                    : typeof data.text === 'string'
                        ? data.text
                        : typeof data.partial === 'string'
                            ? data.partial
                            : typeof data.result === 'string'
                                ? data.result
                                : null

        if (text) {
            const trimmed = text.trim()
            if (trimmed) {
                console.log('[stt] calling onPartial with text:', trimmed)
                completedTextRef.current = []
                lastTextRef.current = trimmed
                onPartialRef.current(trimmed)
            }
        }
    }, [cleanupWebSocket])

    const handleWebSocketMessage = useCallback((event: MessageEvent) => {
        console.log('[stt] ws raw message', {
            dataType: typeof event.data,
            isArrayBuffer: event.data instanceof ArrayBuffer,
            isBlob: event.data instanceof Blob,
            dataLength: typeof event.data === 'string' ? event.data.length : event.data?.byteLength ?? event.data?.size
        })

        if (typeof event.data === 'string') {
            console.log('[stt] ws string data:', event.data.substring(0, 500))
            handleWebSocketPayload(event.data, true)
            return
        }

        if (event.data instanceof ArrayBuffer) {
            const decoded = new TextDecoder().decode(event.data)
            console.log('[stt] ws arraybuffer decoded:', decoded.substring(0, 500))
            handleWebSocketPayload(decoded, false)
            return
        }

        if (event.data instanceof Blob) {
            event.data.text()
                .then(text => {
                    console.log('[stt] ws blob decoded:', text.substring(0, 500))
                    handleWebSocketPayload(text, false)
                })
                .catch(err => {
                    console.error('[stt] ws message parse error', err)
                })
            return
        }

        console.warn('[stt] ws message unknown payload', event.data)
    }, [handleWebSocketPayload])

    const connectWebSocket = useCallback((): Promise<boolean> => {
        // Always create a fresh connection for each recording session
        // This avoids issues with server-side session state and connection reuse
        if (wsRef.current) {
            console.log('[stt] closing existing ws connection before creating new one')
            wsRef.current.onclose = null // Remove the onclose handler to avoid side effects
            wsRef.current.close()
            wsRef.current = null
        }

        return new Promise((resolve) => {
            clientUidRef.current = getClientUid()
            const ws = new WebSocket(wsUrlRef.current)
            ws.binaryType = 'arraybuffer'
            wsRef.current = ws

            const timeout = setTimeout(() => {
                if (ws.readyState !== WebSocket.OPEN) {
                    ws.close()
                    resolve(false)
                }
            }, 10000)

            ws.onopen = () => {
                console.log('[stt] ws connected')
                // Send configuration
                const config = {
                    uid: clientUidRef.current,
                    language: 'zh',
                    task: 'transcribe',
                    model: 'whisper-large-v3',
                    use_vad: true
                }
                ws.send(JSON.stringify(config))
                clearTimeout(timeout)
                resolve(true)
            }

            ws.onmessage = handleWebSocketMessage

            ws.onerror = (event) => {
                console.error('[stt] ws error', event)
                clearTimeout(timeout)
                resolve(false)
            }

            ws.onclose = (event) => {
                console.log('[stt] ws closed', event.code, event.reason)
                wsRef.current = null
                if (statusRef.current === 'recording') {
                    // Unexpected close during recording
                    const finalText = [...completedTextRef.current, lastTextRef.current].join('').trim()
                    if (finalText) {
                        onFinalRef.current(finalText)
                    }
                    setStatus('idle')
                    resetStreamState()
                }
            }
        })
    }, [handleWebSocketMessage, resetStreamState])

    const prepare = useCallback(async (): Promise<boolean> => {
        console.log('[stt] prepare start', {
            prepared: preparedRef.current,
            hasStream: Boolean(mediaStreamRef.current),
            status: statusRef.current
        })

        // Note: We don't pre-warm WebSocket connection anymore because
        // we create a fresh connection for each recording session to avoid
        // server-side session state issues

        if (preparedRef.current && mediaStreamRef.current && audioContextRef.current) {
            return true
        }

        if (!navigator?.mediaDevices?.getUserMedia) {
            handleError('Microphone access is not supported')
            return false
        }

        const audioContextCtor = getAudioContextCtor()
        if (!audioContextCtor) {
            handleError('AudioContext not supported')
            return false
        }

        try {
            const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
            const audioContext = new audioContextCtor()
            const source = audioContext.createMediaStreamSource(mediaStream)
            const processor = audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1)
            const gain = audioContext.createGain()
            gain.gain.value = 0

            processor.onaudioprocess = (event: AudioProcessingEvent) => {
                if (!capturingRef.current) return
                const input = event.inputBuffer.getChannelData(0)
                const resampled = resampleToTarget(input, audioContext.sampleRate)

                // Add to buffer
                const buffer = sampleBufferRef.current
                for (let i = 0; i < resampled.length; i += 1) {
                    buffer.push(resampled[i] ?? 0)
                }

                // Process chunks
                while (buffer.length >= CHUNK_SAMPLES) {
                    const chunkSamples = buffer.splice(0, CHUNK_SAMPLES)
                    const chunk = new Float32Array(chunkSamples)

                    // Calculate volume
                    let sum = 0
                    for (let i = 0; i < chunk.length; i += 1) {
                        const sample = chunk[i]
                        sum += sample * sample
                    }
                    const rms = Math.sqrt(sum / chunk.length)
                    const db = 20 * Math.log10(Math.max(VOLUME_DB_EPSILON, rms))
                    const normalized = Math.min(1, Math.max(0, (db + VOLUME_DB_FLOOR) / VOLUME_DB_FLOOR))
                    const smoothed = volumeRef.current * VOLUME_SMOOTHING + normalized * (1 - VOLUME_SMOOTHING)
                    volumeRef.current = smoothed
                    setVolume(smoothed)

                    // Send chunk
                    sendAudioChunkRef.current(chunk)
                }
            }

            source.connect(processor)
            processor.connect(gain)
            gain.connect(audioContext.destination)

            if (audioContext.state === 'suspended') {
                await audioContext.resume()
            }

            mediaStreamRef.current = mediaStream
            audioContextRef.current = audioContext
            sourceRef.current = source
            processorRef.current = processor
            gainRef.current = gain
            preparedRef.current = true
            console.log('[stt] prepare done', {
                sampleRate: audioContext.sampleRate,
                prepared: preparedRef.current
            })
            return true
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Microphone access denied'
            handleError(message)
            return false
        }
    }, [connectWebSocket, handleError])

    const start = useCallback(async () => {
        if (status === 'recording' || status === 'stopping' || status === 'connecting') return
        setError(null)
        const attempt = startAttemptRef.current + 1
        startAttemptRef.current = attempt

        setStatus('connecting')

        // Prepare audio first
        const audioOk = await prepare()
        if (!audioOk || attempt !== startAttemptRef.current) {
            setStatus('idle')
            return
        }

        // Reset state before connecting (but preserve attempt counter)
        sampleBufferRef.current = []
        lastTextRef.current = ''
        completedTextRef.current = []
        chunkCountRef.current = 0

        // Connect WebSocket
        const wsOk = await connectWebSocket()
        if (!wsOk || attempt !== startAttemptRef.current) {
            handleError('Failed to connect to speech server')
            return
        }

        // Start capturing audio
        capturingRef.current = true
        volumeRef.current = 0
        setVolume(0)
        setStatus('recording')
        console.log('[stt] start', {
            clientUid: clientUidRef.current
        })
    }, [connectWebSocket, handleError, prepare, status])

    const stop = useCallback(() => {
        if (status !== 'recording' && status !== 'connecting') return

        // Increment attempt to cancel any in-progress start
        startAttemptRef.current += 1
        stoppingRef.current = true
        volumeRef.current = 0
        setVolume(0)

        console.log('[stt] stop', {
            clientUid: clientUidRef.current,
            wasConnecting: status === 'connecting'
        })

        // If we were connecting, just cancel - no final text
        // Don't cleanup WebSocket here - keep it warm for next recording
        if (status === 'connecting') {
            capturingRef.current = false
            stoppingRef.current = false
            setStatus('idle')
            return
        }

        setStatus('stopping')

        // Delay stopping capture to allow remaining audio in the pipeline to be processed
        // AudioContext processes audio in chunks, so we need to wait a bit
        setTimeout(() => {
            capturingRef.current = false

            // Send remaining audio buffer if any
            const remainingBuffer = sampleBufferRef.current
            if (remainingBuffer.length > 0) {
                const chunk = new Float32Array(remainingBuffer)
                sampleBufferRef.current = []
                sendAudioChunkRef.current(chunk)
            }

            // Send end-of-stream signal
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                console.log('[stt] sending end-of-stream signal')
                wsRef.current.send(JSON.stringify({ uid: clientUidRef.current, message: 'END_STREAM' }))
            }
        }, 150) // Wait 150ms to capture remaining audio

        // Wait for server to process remaining audio and send final results
        setTimeout(() => {
            // Collect final text
            const finalText = [...completedTextRef.current, lastTextRef.current].join('').trim()
            console.log('[stt] final text after wait', { finalText })

            // Close WebSocket
            cleanupWebSocket()

            // Notify final result
            if (finalText) {
                onFinalRef.current(finalText)
            }

            stoppingRef.current = false
            setStatus('idle')
        }, 1000) // Reduced: 150ms audio flush + 850ms server processing
    }, [cleanupWebSocket, status])

    const toggle = useCallback(async () => {
        if (status === 'recording' || status === 'connecting') {
            stop()
        } else if (status === 'idle' || status === 'error') {
            await start()
        }
    }, [start, status, stop])

    const teardown = useCallback(() => {
        if (status === 'recording' || status === 'connecting') {
            stop()
        }
        cleanupWebSocket()
        cleanupAudio()
        preparedRef.current = false
        resetStreamState()
        setStatus('idle')
        console.log('[stt] teardown')
    }, [cleanupWebSocket, cleanupAudio, resetStreamState, status, stop])

    useEffect(() => {
        return () => {
            capturingRef.current = false
            stoppingRef.current = false
            cleanupWebSocket()
            cleanupAudio()
            preparedRef.current = false
            resetStreamState()
            setStatus('idle')
            console.log('[stt] unmount cleanup')
        }
    }, [cleanupWebSocket, cleanupAudio, resetStreamState])

    const isSupported = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)

    return {
        status,
        error,
        isSupported,
        volume,
        prepare,
        teardown,
        start,
        stop,
        toggle
    }
}
