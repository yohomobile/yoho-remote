import {
    SignJWT,
    exportJWK,
    generateKeyPair,
    jwtVerify,
    type JWK,
} from 'jose'

type GeneratedKeyPair = Awaited<ReturnType<typeof generateKeyPair>>

export type FakeKeycloakUser = {
    sub: string
    email: string
    name: string
    roles: string[]
}

export type FakeKeycloakConfig = {
    publicUrl: string
    realm: string
    clientId: string
    clientSecret: string
    defaultUser: FakeKeycloakUser
}

export type FakeKeycloakTokens = {
    accessToken: string
    refreshToken: string
    idToken: string
    expiresIn: number
    tokenType: 'Bearer'
    user: FakeKeycloakUser
}

export class FakeKeycloak {
    private readonly expiresIn = 900
    private privateKey: GeneratedKeyPair['privateKey'] | null = null
    private publicKey: GeneratedKeyPair['publicKey'] | null = null
    private publicJwk: JWK | null = null
    private readonly kid = 'yoho-remote-e2e-key'
    private readonly codes = new Map<string, FakeKeycloakUser>()
    private readonly refreshTokens = new Map<string, FakeKeycloakUser>()

    constructor(private readonly config: FakeKeycloakConfig) {}

    async init(): Promise<void> {
        const keyPair = await generateKeyPair('RS256', { extractable: true })
        this.privateKey = keyPair.privateKey
        this.publicKey = keyPair.publicKey
        this.publicJwk = {
            ...(await exportJWK(keyPair.publicKey)),
            kid: this.kid,
            alg: 'RS256',
            use: 'sig',
        }
    }

    get issuer(): string {
        return `${this.config.publicUrl}/realms/${this.config.realm}`
    }

    get jwks(): { keys: JWK[] } {
        if (!this.publicJwk) {
            throw new Error('FakeKeycloak is not initialized')
        }
        return { keys: [this.publicJwk] }
    }

    createAuthorizationCode(user: FakeKeycloakUser = this.config.defaultUser): string {
        const code = `code-${crypto.randomUUID()}`
        this.codes.set(code, user)
        return code
    }

    async exchangeCode(code: string): Promise<FakeKeycloakTokens> {
        const user = this.codes.get(code)
        if (!user) {
            throw new Error(`Invalid fake authorization code: ${code}`)
        }
        this.codes.delete(code)
        return await this.issueTokens(user)
    }

    async refresh(refreshToken: string): Promise<FakeKeycloakTokens> {
        const user = this.refreshTokens.get(refreshToken)
        if (!user) {
            throw new Error('Invalid fake refresh token')
        }
        return await this.issueTokens(user)
    }

    async issueTokens(user: FakeKeycloakUser = this.config.defaultUser): Promise<FakeKeycloakTokens> {
        if (!this.privateKey) {
            throw new Error('FakeKeycloak is not initialized')
        }

        const accessToken = await this.signToken(user, 'access')
        const idToken = await this.signToken(user, 'id')
        const refreshToken = `refresh-${crypto.randomUUID()}`
        this.refreshTokens.set(refreshToken, user)

        return {
            accessToken,
            refreshToken,
            idToken,
            expiresIn: this.expiresIn,
            tokenType: 'Bearer',
            user,
        }
    }

    async verifyAccessToken(token: string): Promise<unknown> {
        if (!this.publicKey) {
            throw new Error('FakeKeycloak is not initialized')
        }
        const { payload } = await jwtVerify(token, this.publicKey, {
            issuer: this.issuer,
        })
        return payload
    }

    private async signToken(user: FakeKeycloakUser, tokenUse: 'access' | 'id'): Promise<string> {
        if (!this.privateKey) {
            throw new Error('FakeKeycloak is not initialized')
        }

        return await new SignJWT({
            typ: tokenUse === 'access' ? 'Bearer' : 'ID',
            sub: user.sub,
            email: user.email,
            email_verified: true,
            name: user.name,
            preferred_username: user.email,
            azp: this.config.clientId,
            realm_access: { roles: user.roles },
            resource_access: {
                [this.config.clientId]: { roles: user.roles },
            },
            })
            .setProtectedHeader({ alg: 'RS256', kid: this.kid })
            .setIssuer(this.issuer)
            .setAudience([this.config.clientId, 'account'])
            .setIssuedAt()
            .setExpirationTime(`${this.expiresIn}s`)
            .sign(this.privateKey)
    }
}
