export function shouldBypassOrgGate(pathname: string): boolean {
    return pathname.startsWith('/invitations/accept/')
}
