declare module 'bun:test' {
    export const describe: (...args: any[]) => any
    export const expect: (...args: any[]) => any
    export const test: (...args: any[]) => any
}

declare const Bun: {
    file(path: string | URL): {
        text(): Promise<string>
    }
}
