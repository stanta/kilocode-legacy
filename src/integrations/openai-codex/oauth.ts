import * as crypto from "crypto"
import * as http from "http"
import { URL } from "url"
import type { ExtensionContext } from "vscode"
import { z } from "zod"
import { withCodexOAuthLock } from "./oauth-refresh-lock"

/**
 * OpenAI Codex OAuth Configuration
 *
 * Based on the OpenAI Codex OAuth implementation guide:
 * - ISSUER: https://auth.openai.com
 * - Authorization endpoint: https://auth.openai.com/oauth/authorize
 * - Token endpoint: https://auth.openai.com/oauth/token
 * - Fixed callback port: 1455
 * - Codex-specific params: codex_cli_simplified_flow=true, originator=kilo-code
 */
export const OPENAI_CODEX_OAUTH_CONFIG = {
	authorizationEndpoint: "https://auth.openai.com/oauth/authorize",
	tokenEndpoint: "https://auth.openai.com/oauth/token",
	clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
	redirectUri: "http://localhost:1455/auth/callback",
	scopes: "openid profile email offline_access",
	callbackPort: 1455,
} as const

// kilocode_change start
// Token storage key (exported for agent-manager to pass credentials to agent processes)
export const OPENAI_CODEX_CREDENTIALS_KEY = "openai-codex-oauth-credentials"
// kilocode_change end

// Credentials schema
const openAiCodexCredentialsSchema = z.object({
	type: z.literal("openai-codex"),
	access_token: z.string().min(1),
	refresh_token: z.string().min(1),
	// expires is in milliseconds since epoch
	expires: z.number(),
	email: z.string().optional(),
	// ChatGPT account ID extracted from JWT claims (for ChatGPT-Account-Id header)
	accountId: z.string().optional(),
})

export type OpenAiCodexCredentials = z.infer<typeof openAiCodexCredentialsSchema>

// Token response schema from OpenAI
const tokenResponseSchema = z.object({
	access_token: z.string(),
	refresh_token: z.string().min(1).optional(),
	id_token: z.string().optional(),
	expires_in: z.number(),
	email: z.string().optional(),
	token_type: z.string().optional(),
})

/**
 * JWT claims structure for extracting ChatGPT account ID
 */
interface IdTokenClaims {
	chatgpt_account_id?: string
	organizations?: Array<{ id: string }>
	email?: string
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string
	}
}

/**
 * Parse JWT claims from a token
 * Returns undefined if the token is invalid or cannot be parsed
 */
function parseJwtClaims(token: string): IdTokenClaims | undefined {
	const parts = token.split(".")
	if (parts.length !== 3) return undefined
	try {
		// Use base64url decoding (Node.js Buffer handles this)
		const payload = Buffer.from(parts[1], "base64url").toString("utf-8")
		return JSON.parse(payload) as IdTokenClaims
	} catch {
		return undefined
	}
}

/**
 * Extract ChatGPT account ID from JWT claims
 * Checks multiple locations:
 * 1. Root-level chatgpt_account_id
 * 2. Nested under https://api.openai.com/auth
 * 3. First organization ID
 */
function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
	return (
		claims.chatgpt_account_id ||
		claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
		claims.organizations?.[0]?.id
	)
}

/**
 * Extract ChatGPT account ID from token response
 * Tries id_token first, then access_token
 */
function extractAccountId(tokens: { id_token?: string; access_token: string }): string | undefined {
	// Try id_token first (more reliable source)
	if (tokens.id_token) {
		const claims = parseJwtClaims(tokens.id_token)
		const accountId = claims && extractAccountIdFromClaims(claims)
		if (accountId) return accountId
	}
	// Fall back to access_token
	if (tokens.access_token) {
		const claims = parseJwtClaims(tokens.access_token)
		return claims ? extractAccountIdFromClaims(claims) : undefined
	}
	return undefined
}

class OpenAiCodexOAuthTokenError extends Error {
	public readonly status?: number
	public readonly errorCode?: string

	constructor(message: string, opts?: { status?: number; errorCode?: string }) {
		super(message)
		this.name = "OpenAiCodexOAuthTokenError"
		this.status = opts?.status
		this.errorCode = opts?.errorCode
	}

	public isLikelyInvalidGrant(): boolean {
		if (this.errorCode && /invalid_grant/i.test(this.errorCode)) {
			return true
		}
		if (this.status === 400 || this.status === 401 || this.status === 403) {
			return /invalid_grant|revoked|expired|invalid refresh/i.test(this.message)
		}
		return false
	}
}

function parseOAuthErrorDetails(errorText: string): { errorCode?: string; errorMessage?: string } {
	try {
		const json: unknown = JSON.parse(errorText)
		if (!json || typeof json !== "object") {
			return {}
		}

		const obj = json as Record<string, unknown>
		const errorField = obj.error

		const errorCode: string | undefined =
			typeof errorField === "string"
				? errorField
				: errorField &&
					  typeof errorField === "object" &&
					  typeof (errorField as Record<string, unknown>).type === "string"
					? ((errorField as Record<string, unknown>).type as string)
					: undefined

		const errorDescription = obj.error_description
		const errorMessageFromError =
			errorField && typeof errorField === "object" ? (errorField as Record<string, unknown>).message : undefined

		const errorMessage: string | undefined =
			typeof errorDescription === "string"
				? errorDescription
				: typeof errorMessageFromError === "string"
					? errorMessageFromError
					: typeof obj.message === "string"
						? obj.message
						: undefined

		return { errorCode, errorMessage }
	} catch {
		return {}
	}
}

/**
 * Generates a cryptographically random PKCE code verifier
 * Must be 43-128 characters long using unreserved characters
 */
export function generateCodeVerifier(): string {
	const buffer = crypto.randomBytes(32)
	return buffer.toString("base64url")
}

/**
 * Generates the PKCE code challenge from the verifier using S256 method
 */
export function generateCodeChallenge(verifier: string): string {
	const hash = crypto.createHash("sha256").update(verifier).digest()
	return hash.toString("base64url")
}

/**
 * Generates a random state parameter for CSRF protection
 */
export function generateState(): string {
	return crypto.randomBytes(16).toString("hex")
}

/**
 * Builds the authorization URL for OpenAI Codex OAuth flow
 * Includes Codex-specific parameters per the implementation guide
 */
export function buildAuthorizationUrl(codeChallenge: string, state: string): string {
	const params = new URLSearchParams({
		client_id: OPENAI_CODEX_OAUTH_CONFIG.clientId,
		redirect_uri: OPENAI_CODEX_OAUTH_CONFIG.redirectUri,
		scope: OPENAI_CODEX_OAUTH_CONFIG.scopes,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		response_type: "code",
		state,
		// Codex-specific parameters
		codex_cli_simplified_flow: "true",
		originator: "kilo-code",
	})

	return `${OPENAI_CODEX_OAUTH_CONFIG.authorizationEndpoint}?${params.toString()}`
}

/**
 * Exchanges the authorization code for tokens
 * Important: Uses application/x-www-form-urlencoded (not JSON)
 * Important: state must NOT be included in token exchange body
 */
export async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<OpenAiCodexCredentials> {
	// Per the implementation guide: use application/x-www-form-urlencoded
	// and do NOT include state in the body (OpenAI returns error if included)
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: OPENAI_CODEX_OAUTH_CONFIG.clientId,
		code,
		redirect_uri: OPENAI_CODEX_OAUTH_CONFIG.redirectUri,
		code_verifier: codeVerifier,
	})

	const response = await fetch(OPENAI_CODEX_OAUTH_CONFIG.tokenEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: body.toString(),
		signal: AbortSignal.timeout(30000),
	})

	if (!response.ok) {
		const errorText = await response.text()
		throw new Error(`Token exchange failed: ${response.status} ${response.statusText} - ${errorText}`)
	}

	const data = await response.json()
	const tokenResponse = tokenResponseSchema.parse(data)

	if (!tokenResponse.refresh_token) {
		throw new Error("Token exchange did not return a refresh_token")
	}

	// Per the implementation guide: expires is in milliseconds since epoch
	const expiresAt = Date.now() + tokenResponse.expires_in * 1000

	// Extract ChatGPT account ID from JWT claims
	const accountId = extractAccountId({
		id_token: tokenResponse.id_token,
		access_token: tokenResponse.access_token,
	})

	return {
		type: "openai-codex",
		access_token: tokenResponse.access_token,
		refresh_token: tokenResponse.refresh_token,
		expires: expiresAt,
		email: tokenResponse.email,
		accountId,
	}
}

/**
 * Refreshes the access token using the refresh token
 * Uses application/x-www-form-urlencoded (not JSON)
 */
export async function refreshAccessToken(
	credentials: OpenAiCodexCredentials,
	lockSignal?: AbortSignal,
): Promise<OpenAiCodexCredentials> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: OPENAI_CODEX_OAUTH_CONFIG.clientId,
		refresh_token: credentials.refresh_token,
	})

	const response = await fetch(OPENAI_CODEX_OAUTH_CONFIG.tokenEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: body.toString(),
		signal: lockSignal ? AbortSignal.any([lockSignal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
	})

	if (!response.ok) {
		const errorText = await response.text()
		const { errorCode } = parseOAuthErrorDetails(errorText)
		// Raw token endpoint bodies can contain secrets; never put them in errors or logs.
		throw new OpenAiCodexOAuthTokenError("OpenAI Codex token refresh failed (HTTP " + response.status + ")", {
			status: response.status,
			errorCode,
		})
	}

	const data = await response.json()
	const tokenResponse = tokenResponseSchema.parse(data)

	// Per the implementation guide: expires is in milliseconds since epoch
	const expiresAt = Date.now() + tokenResponse.expires_in * 1000

	// Extract new account ID from refreshed tokens, or preserve existing one
	const newAccountId = extractAccountId({
		id_token: tokenResponse.id_token,
		access_token: tokenResponse.access_token,
	})

	return {
		type: "openai-codex",
		access_token: tokenResponse.access_token,
		refresh_token: tokenResponse.refresh_token ?? credentials.refresh_token,
		expires: expiresAt,
		email: tokenResponse.email ?? credentials.email,
		// Prefer newly extracted accountId, fall back to existing
		accountId: newAccountId ?? credentials.accountId,
	}
}

/**
 * Checks if the credentials are expired (with 5 minute buffer)
 * Per the implementation guide: expires is in milliseconds since epoch
 */
export function isTokenExpired(credentials: OpenAiCodexCredentials): boolean {
	const bufferMs = 5 * 60 * 1000 // 5 minutes buffer
	return Date.now() >= credentials.expires - bufferMs
}

/**
 * OpenAiCodexOAuthManager - Handles OAuth flow and token management
 */
export class OpenAiCodexOAuthManager {
	private context: ExtensionContext | null = null
	private credentials: OpenAiCodexCredentials | null = null
	private logFn: ((message: string) => void) | null = null
	private refreshPromise: Promise<OpenAiCodexCredentials | null> | null = null
	private secretSubscription?: { dispose(): void }
	private cacheGeneration = 0
	private authorizationGeneration = 0
	private pendingAuth: {
		codeVerifier: string
		state: string
		server?: http.Server
	} | null = null

	private log(message: string): void {
		try {
			;(this.logFn ?? console.log)(message)
		} catch {
			// Diagnostics must never interrupt a request.
		}
	}

	initialize(context: ExtensionContext, logFn?: (message: string) => void): void {
		this.secretSubscription?.dispose()
		this.context = context
		this.logFn = logFn ?? null
		this.credentials = null
		this.cacheGeneration++
		this.secretSubscription = context.secrets.onDidChange?.((event) => {
			if (event.key === OPENAI_CODEX_CREDENTIALS_KEY) {
				this.cacheGeneration++
				this.credentials = null
			}
		})
	}

	dispose(): void {
		this.cancelAuthorizationFlow()
		this.secretSubscription?.dispose()
		this.secretSubscription = undefined
		this.credentials = null
		this.cacheGeneration++
		this.context = null
	}

	private requireContext(): ExtensionContext {
		if (!this.context) throw new Error("OpenAI Codex OAuth manager not initialized")
		return this.context
	}

	private async readStoredCredentials(): Promise<OpenAiCodexCredentials | null> {
		const raw = await this.requireContext().secrets.get(OPENAI_CODEX_CREDENTIALS_KEY)
		return raw ? openAiCodexCredentialsSchema.parse(JSON.parse(raw)) : null
	}

	private async writeUnlocked(credentials: OpenAiCodexCredentials): Promise<void> {
		await this.requireContext().secrets.store(OPENAI_CODEX_CREDENTIALS_KEY, JSON.stringify(credentials))
		this.credentials = credentials
		this.cacheGeneration++
	}

	async loadCredentials(): Promise<OpenAiCodexCredentials | null> {
		if (!this.context) return null
		for (let attempt = 0; attempt < 4; attempt++) {
			const generation = this.cacheGeneration
			try {
				const current = await this.readStoredCredentials()
				if (generation !== this.cacheGeneration) continue
				this.credentials = current
				return current
			} catch {
				if (generation !== this.cacheGeneration) continue
				this.credentials = null
				return null
			}
		}
		// A concurrent login/logout invalidated all reads; fail closed.
		this.credentials = null
		return null
	}

	async saveCredentials(credentials: OpenAiCodexCredentials): Promise<void> {
		const validated = openAiCodexCredentialsSchema.parse(credentials)
		await withCodexOAuthLock(this.requireContext(), async (lockSignal) => {
			if (lockSignal.aborted) throw new Error("OpenAI Codex OAuth lock lost")
			await this.writeUnlocked(validated)
		})
	}

	async clearCredentials(): Promise<void> {
		if (!this.context) return
		this.authorizationGeneration++
		this.cancelAuthorizationFlow()
		await withCodexOAuthLock(this.requireContext(), async (lockSignal) => {
			if (lockSignal.aborted) throw new Error("OpenAI Codex OAuth lock lost")
			await this.requireContext().secrets.delete(OPENAI_CODEX_CREDENTIALS_KEY)
			this.credentials = null
			this.cacheGeneration++
		})
	}

	private async runRefresh(rejectedAccessToken?: string): Promise<OpenAiCodexCredentials | null> {
		// Local single-flight encompasses storage read, network refresh AND persistence.
		if (!this.refreshPromise) {
			const operation = withCodexOAuthLock(this.requireContext(), async (lockSignal) => {
				// Another window may have refreshed or logged out while we waited.
				const current = await this.readStoredCredentials()
				if (!current) {
					this.credentials = null
					return null
				}
				if (rejectedAccessToken ? current.access_token !== rejectedAccessToken : !isTokenExpired(current)) {
					this.credentials = current
					return current
				}
				const refreshed = await refreshAccessToken(current, lockSignal)
				if (lockSignal.aborted) throw new Error("OpenAI Codex OAuth lock lost")
				// Observe out-of-protocol writes (including older installed extension versions).
				const latest = await this.readStoredCredentials()
				if (!latest || JSON.stringify(latest) !== JSON.stringify(current)) {
					this.credentials = latest
					return latest
				}
				await this.writeUnlocked(refreshed)
				if (lockSignal.aborted) throw new Error("OpenAI Codex OAuth lock lost")
				return refreshed
			})
			this.refreshPromise = operation
			void operation.finally(() => {
				if (this.refreshPromise === operation) this.refreshPromise = null
			}).catch(() => {})
		}
		return this.refreshPromise
	}

	async getTokenSnapshot(): Promise<{ accessToken: string; accountId?: string } | null> {
		const credentials = await this.loadCredentials()
		if (!credentials) return null
		const current = isTokenExpired(credentials) ? await this.runRefresh() : credentials
		return current ? { accessToken: current.access_token, accountId: current.accountId } : null
	}

	async forceRefreshTokenSnapshot(
		rejectedAccessToken: string,
	): Promise<{ accessToken: string; accountId?: string } | null> {
		const credentials = await this.runRefresh(rejectedAccessToken)
		return credentials ? { accessToken: credentials.access_token, accountId: credentials.accountId } : null
	}

	// Compatibility with callers that only consume an access token.
	async getAccessToken(): Promise<string | null> {
		return (await this.getTokenSnapshot())?.accessToken ?? null
	}

	async forceRefreshAccessToken(): Promise<string | null> {
		const current = await this.loadCredentials()
		return current ? (await this.forceRefreshTokenSnapshot(current.access_token))?.accessToken ?? null : null
	}

	async getAccountId(): Promise<string | null> {
		return (await this.loadCredentials())?.accountId ?? null
	}

	async getEmail(): Promise<string | null> {
		return (await this.loadCredentials())?.email ?? null
	}

	// Status checks must never rotate tokens or call the network.
	async isAuthenticated(): Promise<boolean> {
		return (await this.loadCredentials()) !== null
	}

	/**
	 * Start the OAuth authorization flow
	 * Returns the authorization URL to open in browser
	 */
	startAuthorizationFlow(): string {
		// Cancel any existing authorization flow before starting a new one
		this.cancelAuthorizationFlow()

		const codeVerifier = generateCodeVerifier()
		const codeChallenge = generateCodeChallenge(codeVerifier)
		const state = generateState()

		this.authorizationGeneration++
		this.pendingAuth = {
			codeVerifier,
			state,
		}

		return buildAuthorizationUrl(codeChallenge, state)
	}

	/**
	 * Start a local server to receive the OAuth callback
	 * Returns a promise that resolves when authentication is complete
	 */
	async waitForCallback(): Promise<OpenAiCodexCredentials> {
		if (!this.pendingAuth) {
			throw new Error("No pending authorization flow")
		}

		// Close any existing server before starting a new one
		if (this.pendingAuth.server) {
			try {
				this.pendingAuth.server.close()
			} catch {
				// Ignore errors when closing
			}
			this.pendingAuth.server = undefined
		}

		const pendingAuth = this.pendingAuth
		const authGeneration = this.authorizationGeneration
		return new Promise((resolve, reject) => {
			const server = http.createServer(async (req, res) => {
				try {
					const url = new URL(req.url || "", `http://localhost:${OPENAI_CODEX_OAUTH_CONFIG.callbackPort}`)

					if (url.pathname !== "/auth/callback") {
						res.writeHead(404)
						res.end("Not Found")
						return
					}

					const code = url.searchParams.get("code")
					const state = url.searchParams.get("state")
					const error = url.searchParams.get("error")

					if (error) {
						res.writeHead(400)
						res.end(`Authentication failed: ${error}`)
						reject(new Error(`OAuth error: ${error}`))
						server.close()
						return
					}

					if (!code || !state) {
						res.writeHead(400)
						res.end("Missing code or state parameter")
						reject(new Error("Missing code or state parameter"))
						server.close()
						return
					}

					if (state !== this.pendingAuth?.state) {
						res.writeHead(400)
						res.end("State mismatch - possible CSRF attack")
						reject(new Error("State mismatch"))
						server.close()
						return
					}

					try {
						// Note: state is validated above but not passed to exchangeCodeForTokens
						// per the implementation guide (OpenAI rejects it)
						const credentials = await exchangeCodeForTokens(code, pendingAuth.codeVerifier)
						if (this.pendingAuth !== pendingAuth || this.authorizationGeneration !== authGeneration) {
							throw new Error("Authorization flow was cancelled or superseded")
						}
						await this.saveCredentials(credentials)

						res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
						res.end(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Authentication Successful</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100vh;
    margin: 0;
    background: linear-gradient(135deg, #10a37f 0%, #0d8f6f 100%);
    color: white;
  }
  .container {
    text-align: center;
    padding: 2rem;
  }
  h1 { font-size: 2rem; margin-bottom: 1rem; }
  p { opacity: 0.9; }
</style>
</head>
<body>
<div class="container">
<h1>&#10003; Authentication Successful</h1>
<p>You can close this window and return to VS Code.</p>
</div>
<script>setTimeout(() => window.close(), 3000);</script>
</body>
</html>`)

						this.pendingAuth = null
						server.close()
						resolve(credentials)
					} catch (exchangeError) {
						res.writeHead(500)
						res.end("Token exchange failed")
						reject(exchangeError)
						server.close()
					}
				} catch (err) {
					res.writeHead(500)
					res.end("Internal server error")
					reject(err)
					server.close()
				}
			})

			server.on("error", (err: NodeJS.ErrnoException) => {
				this.pendingAuth = null
				if (err.code === "EADDRINUSE") {
					reject(
						new Error(
							`Port ${OPENAI_CODEX_OAUTH_CONFIG.callbackPort} is already in use. ` +
								`Please close any other applications using this port and try again.`,
						),
					)
				} else {
					reject(err)
				}
			})

			// Set a timeout for the callback
			const timeout = setTimeout(
				() => {
					server.close()
					reject(new Error("Authentication timed out"))
				},
				5 * 60 * 1000,
			) // 5 minutes

			server.listen(OPENAI_CODEX_OAUTH_CONFIG.callbackPort, () => {
				if (this.pendingAuth) {
					this.pendingAuth.server = server
				}
			})

			// Clear timeout when server closes
			server.on("close", () => {
				clearTimeout(timeout)
			})
		})
	}

	/**
	 * Cancel any pending authorization flow
	 */
	cancelAuthorizationFlow(): void {
		if (this.pendingAuth?.server) {
			this.pendingAuth.server.close()
		}
		this.pendingAuth = null
		this.authorizationGeneration++
	}

	/**
	 * Get the current credentials (for display purposes)
	 */
	getCredentials(): OpenAiCodexCredentials | null {
		return this.credentials
	}
}

// Singleton instance
export const openAiCodexOAuthManager = new OpenAiCodexOAuthManager()
