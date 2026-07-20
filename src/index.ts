import type { Plugin } from '@opencode-ai/plugin'
import { AccountStore, computeCooldownUntil } from './accounts.ts'
import { authorize, exchange } from './auth.ts'
import { debugLog, inspectStream, isFailoverStatus } from './failover.ts'
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

          type Tokens = { access: string; refresh: string; expires: number }

          // Per-account inflight refresh promises — prevents concurrent token
          // refreshes for the same account from racing (and causing 401
          // cascades under refresh-token rotation). Keyed by account id.
          const refreshPromises = new Map<string, Promise<Tokens>>()

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
           * Ensure a candidate has a valid (non-expired) token set, refreshing
           * if necessary. Deduplicates concurrent refreshes per id. Returns the
           * full token set so a working account can be promoted to primary.
           */
          async function ensureFreshTokens(candidate: {
            id: string
            refresh: string
            access: string
            expires: number
          }): Promise<Tokens> {
            if (
              candidate.access &&
              candidate.expires &&
              candidate.expires >= Date.now()
            ) {
              return {
                access: candidate.access,
                refresh: candidate.refresh,
                expires: candidate.expires,
              }
            }

            let inflight = refreshPromises.get(candidate.id)
            if (!inflight) {
              inflight = (async () => {
                const tokens = await refreshAccessToken(candidate.refresh)
                await persistTokens(candidate.id, tokens)
                return tokens
              })().finally(() => {
                refreshPromises.delete(candidate.id)
              })
              refreshPromises.set(candidate.id, inflight)
            }
            return inflight
          }

          /**
           * Promote a (non-primary) account into OpenCode's `anthropic` slot so
           * the next request starts from a healthy account. This self-heals a
           * dead primary (e.g. `invalid_grant`): after one failover, OpenCode's
           * own credential points at a working account instead of the dead one.
           */
          async function promoteToPrimary(tokens: Tokens) {
            try {
              // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose auth.set
              await (client as any).auth.set({
                path: { id: 'anthropic' },
                body: { type: 'oauth', ...tokens },
              })
            } catch {
              // Promotion is best-effort; never break the response over it.
            }
          }

          /**
           * Build the ordered list of candidate accounts to try:
           *   1. the primary (OpenCode) account,
           *   2. store accounts that are available (not cooling down),
           *   3. store accounts that ARE cooling down, as a LAST RESORT.
           *
           * Including cooling accounts (tier 3) is what prevents the session
           * from stalling: even if every account is on cooldown, we still try
           * them rather than surfacing an error and waiting for the user. A
           * cooldown may be stale (e.g. based on an over-long Retry-After), and
           * trying is strictly better than blocking.
           */
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
            type Candidate = {
              id: string
              refresh: string
              access: string
              expires: number
            }
            const candidates: Candidate[] = []
            const seen = new Set<string>()

            if (current.refresh) {
              candidates.push({
                id: PRIMARY_ID,
                refresh: current.refresh,
                access: current.access ?? '',
                expires: current.expires ?? 0,
              })
              seen.add(current.refresh)
            }

            const now = Date.now()
            const all = store.list()

            // Tier 2: available store accounts.
            for (const account of all) {
              if (seen.has(account.refresh)) continue
              if (account.cooldownUntil && account.cooldownUntil > now) continue
              candidates.push({
                id: account.id,
                refresh: account.refresh,
                access: account.access,
                expires: account.expires,
              })
              seen.add(account.refresh)
            }

            // Tier 3: cooling store accounts (last resort).
            for (const account of all) {
              if (seen.has(account.refresh)) continue
              candidates.push({
                id: account.id,
                refresh: account.refresh,
                access: account.access,
                expires: account.expires,
              })
              seen.add(account.refresh)
            }

            return candidates
          }

          /**
           * Put a candidate on cooldown so it's skipped next time. The primary
           * (OpenCode) account isn't in the store, so we can't persist a
           * cooldown for it — but it's always tried first anyway, so failover to
           * the store accounts still happens within a single request.
           */
          function markFailover(
            candidate: { id: string },
            until: number,
            reason: string,
          ) {
            if (candidate.id !== PRIMARY_ID) {
              store.markCooldown(candidate.id, until, reason)
            }
          }

          return {
            apiKey: '',
            async fetch(input: string | URL | Request, init?: RequestInit) {
              const current = await getAuth()
              if (current.type !== 'oauth') return fetch(input, init)

              const candidates = buildCandidates(current)
              debugLog(
                `request: ${candidates.length} candidate account(s)`,
                candidates.map((c) =>
                  c.id === PRIMARY_ID ? 'primary' : c.id.slice(0, 8),
                ),
              )

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
                const isPrimary = candidate.id === PRIMARY_ID
                const tag = isPrimary ? 'primary' : candidate.id.slice(0, 8)

                // 1) Ensure a valid token, refreshing if needed. A refresh
                // failure (e.g. invalid_grant) is NOT surfaced — we cool the
                // account down and move on to the next candidate.
                let tokens: Tokens
                try {
                  tokens = await ensureFreshTokens(candidate)
                } catch (error) {
                  lastError = error
                  const reason =
                    error instanceof Error ? error.message : String(error)
                  // A dead refresh token won't recover soon — cool it down for
                  // an hour rather than retrying it on every request.
                  markFailover(candidate, Date.now() + 60 * 60_000, reason)
                  debugLog(
                    `account ${tag}: refresh failed → ${reason}`,
                    isLast ? '(last candidate)' : '→ next account',
                  )
                  continue
                }

                const requestHeaders = mergeHeaders(input, init)
                setOAuthHeaders(requestHeaders, tokens.access)

                // 2) Issue the request. A network error also fails over.
                let response: Response
                try {
                  response = await fetch(rewritten.input, {
                    ...init,
                    body,
                    headers: requestHeaders,
                    ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
                  })
                } catch (error) {
                  lastError = error
                  debugLog(
                    `account ${tag}: network error → ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  )
                  continue
                }

                // 3a) Hard failover HTTP status (429/401/403/529).
                if (isFailoverStatus(response.status)) {
                  markFailover(
                    candidate,
                    computeCooldownUntil(response.headers.get('retry-after')),
                    `HTTP ${response.status}`,
                  )
                  debugLog(
                    `account ${tag}: HTTP ${response.status} → failover`,
                    isLast ? '(no more accounts)' : '',
                  )
                  lastResponse = response
                  if (!isLast) {
                    await response.body?.cancel().catch(() => {})
                    continue
                  }
                  break
                }

                // 3b) A 2xx whose stream carries an error event before any
                // content (Anthropic returns 200 + an SSE `error` event for
                // rate/usage limits, sometimes a few events in). Inspect the
                // start of the stream without discarding the good data.
                if (response.body) {
                  const { isError, prefixText, stream } = await inspectStream(
                    response.body,
                  )
                  const rebuilt = new Response(stream, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                  })

                  if (isError) {
                    markFailover(
                      candidate,
                      computeCooldownUntil(response.headers.get('retry-after')),
                      'stream error (rate/usage limit)',
                    )
                    debugLog(
                      `account ${tag}: stream error → failover`,
                      isLast ? '(no more accounts)' : '',
                      prefixText.slice(0, 200),
                    )
                    lastResponse = rebuilt
                    if (!isLast) {
                      await stream.cancel().catch(() => {})
                      continue
                    }
                    break
                  }

                  // Success. Self-heal: if a non-primary account served this,
                  // promote it into OpenCode's slot for subsequent requests.
                  if (!isPrimary) {
                    await promoteToPrimary(tokens)
                    debugLog(`account ${tag}: OK → promoted to primary`)
                  } else {
                    debugLog(`account ${tag}: OK`)
                  }
                  return createStrippedStream(rebuilt)
                }

                // Success with no body.
                if (!isPrimary) await promoteToPrimary(tokens)
                debugLog(`account ${tag}: OK (no body)`)
                return createStrippedStream(response)
              }

              // Every candidate failed. Surface the last real API response (so
              // the user sees the genuine error) or rethrow the last error.
              if (lastResponse) {
                debugLog('all candidates exhausted → surfacing last response')
                return createStrippedStream(lastResponse)
              }
              if (lastError) {
                debugLog('all candidates exhausted → throwing last error')
                throw lastError
              }
              // No candidates at all (no refresh token) — plain pass-through.
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
