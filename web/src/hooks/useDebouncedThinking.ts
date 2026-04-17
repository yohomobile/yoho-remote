import { useEffect, useRef, useState } from 'react'

const DEBOUNCE_MS = 2000

export function useDebouncedThinking(thinking: boolean): boolean {
    const [debounced, setDebounced] = useState(thinking)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
        if (thinking) {
            timerRef.current = setTimeout(() => setDebounced(true), DEBOUNCE_MS)
        } else {
            if (timerRef.current) clearTimeout(timerRef.current)
            timerRef.current = null
            setDebounced(false)
        }
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current)
        }
    }, [thinking])

    return debounced
}
