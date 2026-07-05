import type { Plugin } from '@opencode-ai/plugin'
import {
  AccountStore,
  computeCooldownUntil,
  isFailoverStatus,
} from './accounts.ts'
import { authorize, exchange } from './auth.ts'
import { refreshAccessToken } from './refresh.ts'
import {
  createStrippedStream,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'

/**
 * Models not yet present in OpenCode's bundled models.dev snapshot that
 * this plugin injects so they appear in the model selection UI.
 *
 * Pricing: USD per million tokens (same scale as models.dev).
 * Capabilities mirror claude-opus-4-6 (same family/generation).
 */
const INJECTED_MODELS = [
  {
    id: 'claude-opus-4-7',
    providerID: 'anthropic',
    api: {
      id: 'anthropic',
      url: 'https://api.anthropic.com/v1',
      npm: '@ai-sdk/anthropic',
    },
    name: 'Claude Opus 4.7',
    family: 'claude-opus',
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: { field: 'reasoning_content' as const },
    },
    cost: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
    limit: { context: 1_000_000, output: 128_000 },
    status: 'active' as const,
    options: {},
    headers: {},
    release_date: '2026-04-16',
  },
]

export const AnthropicAuthPlugin: Plugin = async ({ client }) => {
  return {
    provider: {
      id: 'anthropic',
      async models(provider: { models: Record<string, unknown> }) {
        const models: Record<string, unknown> = { ...provider.models }
        for (const model of INJECTED_MODELS) {
          // Don't overwrite if OpenCode already knows the model natively
          if (!(model.id in models)) {
            models[model.id] = model
          }
        }
        return models
      },
      // biome-ignore lint/suspicious/noExplicitAny: ProviderHook not yet in typed Hooks interface
    } as any,
    auth: {
      provider: 'anthropic',
      async loader(
        getAuth: () => Promise<{
          type: string
          access?: string
          refresh?: string
          expires?: number
        }>,
        provider: { models: Record<string, { cost: unknown }> },
      ) {
        const auth = await getAuth()
        if (auth.type === 'oauth') {
          // zero out cost for max plan
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            }
          }

          const store = new AccountStore()

          // Per-account inflight refresh promises — prevents concurrent token
          // refreshes for the same account from racing (and causing 401
          // cascades under refresh-token rotation). Keyed by account id.
          const refreshPromises = new Map<string, Promise<string>>()

          /**
           * The "primary" account is OpenCode's own `anthropic` credential.
           * We keep it as the first candidate for backward compatibility and
           * mirror any token rotation back to OpenCode via `client.auth.set`.
           */
          const PRIMARY_ID = '__opencode_primary__'

          /**
           * Persist rotated tokens: for the primary account write back to
           * OpenCode, otherwise update the plugin-owned account store.
           */
          async function persistTokens(
            id: string,
            tokens: { refresh: string; access: string; expires: number },
          ) {
            if (id === PRIMARY_ID) {
              // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose auth.set
              await (client as any).auth.set({
                path: { id: 'anthropic' },
                body: { type: 'oauth', ...tokens },
              })
            } else {
              store.updateTokens(id, tokens)
            }
          }

          /**
           * Ensure a candidate has a valid (non-expired) access token,
           * refreshing if necessary. Deduplicates concurrent refreshes per id.
           */
          async function ensureFreshAccess(candidate: {
            id: string
            refresh: string
            access: string
            expires: number
          }): Promise<string> {
            if (
              candidate.access &&
              candidate.expires &&
              candidate.expires >= Date.now()
            ) {
              return candidate.access
            }

            let inflight = refreshPromises.get(candidate.id)
            if (!inflight) {
              inflight = (async () => {
                const tokens = await refreshAccessToken(candidate.refresh)
                await persistTokens(candidate.id, tokens)
                return tokens.access
              })().finally(() => {
                refreshPromises.delete(candidate.id)
              })
              refreshPromises.set(candidate.id, inflight)
            }
            return inflight
          }

          /** Build the ordered list of candidate accounts to try. */
          function buildCandidates(current: {
            refresh?: string
            access?: string
            expires?: number
          }): Array<{
            id: string
            refresh: string
            access: string
            expires: number
          }> {
            const candidates: Array<{
              id: string
              refresh: string
              access: string
              expires: number
            }> = []

            if (current.refresh) {
              candidates.push({
                id: PRIMARY_ID,
                refresh: current.refresh,
                access: current.access ?? '',
                expires: current.expires ?? 0,
              })
            }

            // Append available (not cooling-down) store accounts, skipping any
            // that duplicate the primary refresh token.
            for (const account of store.available()) {
              if (account.refresh === current.refresh) continue
              candidates.push({
                id: account.id,
                refresh: account.refresh,
                access: account.access,
                expires: account.expires,
              })
            }

            return candidates
          }

          return {
            apiKey: '',
            async fetch(input: string | URL | Request, init?: RequestInit) {
              const current = await getAuth()
              if (current.type !== 'oauth') return fetch(input, init)

              const candidates = buildCandidates(current)

              let body = init?.body
              if (body && typeof body === 'string') {
                body = rewriteRequestBody(body)
              }
              const rewritten = rewriteUrl(input)

              let lastResponse: Response | undefined
              let lastError: unknown

              for (let i = 0; i < candidates.length; i++) {
                const candidate = candidates[i]
                if (!candidate) continue
                const isLast = i === candidates.length - 1

                let access: string
                try {
                  access = await ensureFreshAccess(candidate)
                } catch (error) {
                  // Refresh failed (e.g. invalidated refresh token). Cool down
                  // non-primary accounts and try the next candidate.
                  lastError = error
                  if (candidate.id !== PRIMARY_ID) {
                    store.markCooldown(
                      candidate.id,
                      Date.now() + 5 * 60_000,
                      error instanceof Error ? error.message : String(error),
                    )
                  }
                  if (isLast) throw error
                  continue
                }

                const requestHeaders = mergeHeaders(input, init)
                setOAuthHeaders(requestHeaders, access)

                const response = await fetch(rewritten.input, {
                  ...init,
                  body,
                  headers: requestHeaders,
                  ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
                })

                if (isFailoverStatus(response.status) && !isLast) {
                  // Account is rate-limited / usage-limited / rejected. Record a
                  // cooldown (respecting retry-after) and try the next account.
                  const until = computeCooldownUntil(
                    response.headers.get('retry-after'),
                  )
                  if (candidate.id !== PRIMARY_ID) {
                    store.markCooldown(
                      candidate.id,
                      until,
                      `HTTP ${response.status}`,
                    )
                  }
                  await response.body?.cancel()
                  lastResponse = response
                  continue
                }

                return createStrippedStream(response)
              }

              // All candidates exhausted — surface the last real response so the
              // user sees the actual API error, or rethrow the last error.
              if (lastResponse) return createStrippedStream(lastResponse)
              if (lastError) throw lastError
              // No candidates at all (no refresh token) — fall back to a plain
              // pass-through so behavior matches the single-account baseline.
              return fetch(rewritten.input, {
                ...init,
                body,
                ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
              })
            },
          }
        }

        return {}
      },
      methods: [
        {
          label: 'Claude Pro/Max',
          type: 'oauth',
          authorize: async () => {
            const result = await authorize('max')
            return {
              url: result.url,
              instructions: 'Paste the authorization code here:',
              method: 'code',
              callback: async (code: string) => {
                const credentials = await exchange(
                  code,
                  result.verifier,
                  result.redirectUri,
                  result.state,
                )
                // Mirror the login into the plugin-owned account store so it
                // participates in automatic failover alongside any extra
                // accounts. Deduped by refresh token.
                if (credentials.type === 'success') {
                  try {
                    new AccountStore().add({
                      refresh: credentials.refresh,
                      access: credentials.access,
                      expires: credentials.expires,
                    })
                  } catch {
                    // Store failure must never block a successful login.
                  }
                }
                return credentials
              },
            }
          },
        },
        {
          label: 'Add another Claude account (failover)',
          type: 'oauth',
          authorize: async () => {
            const result = await authorize('max')
            return {
              url: result.url,
              instructions:
                'Log in with a DIFFERENT Claude account, then paste the code here:',
              method: 'code',
              callback: async (code: string) => {
                const credentials = await exchange(
                  code,
                  result.verifier,
                  result.redirectUri,
                  result.state,
                )
                if (credentials.type === 'success') {
                  try {
                    new AccountStore().add({
                      refresh: credentials.refresh,
                      access: credentials.access,
                      expires: credentials.expires,
                    })
                  } catch {
                    // Store failure must never block a successful login.
                  }
                }
                // Returning success also refreshes OpenCode's primary slot to
                // this account; the store dedupes so no account is used twice.
                return credentials
              },
            }
          },
        },
        {
          label: 'Create an API Key',
          type: 'oauth',
          authorize: async () => {
            const result = await authorize('console')
            return {
              url: result.url,
              instructions: 'Paste the authorization code here:',
              method: 'code',
              callback: async (code: string) => {
                const credentials = await exchange(
                  code,
                  result.verifier,
                  result.redirectUri,
                  result.state,
                )
                if (credentials.type === 'failed') return credentials
                const apiKey = await fetch(
                  `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      authorization: `Bearer ${credentials.access}`,
                    },
                  },
                ).then((r) => r.json() as Promise<{ raw_key: string }>)
                return { type: 'success' as const, key: apiKey.raw_key }
              },
            }
          },
        },
        {
          provider: 'anthropic',
          label: 'Manually enter API Key',
          type: 'api',
        },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: Plugin type doesn't include undocumented auth/hooks
  } as any
}
