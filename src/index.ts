import type { Plugin } from '@opencode-ai/plugin'
import { AccountStore, computeCooldownUntil } from './accounts.ts'
import { authorize, exchange } from './auth.ts'
import { debugLog, inspectStream, isFailoverStatus } from './failover.ts'
import { fetchAccountProfile } from './profile.ts'
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
 * Add a freshly-authenticated login to the plugin's account store so it joins
 * automatic failover. The account is labeled by its email: taken from the token
 * response when present, otherwise resolved from the OAuth profile endpoint.
 * Best-effort — a store/profile failure must never block a successful login.
 */
async function storeLoginAccount(credentials: {
  refresh: string
  access: string
  expires: number
  email?: string
}): Promise<void> {
  try {
    let email = credentials.email
    if (!email) {
      const profile = await fetchAccountProfile(credentials.access)
      email = profile?.email
    }
    const store = new AccountStore()
    store.add({
      refresh: credentials.refresh,
      access: credentials.access,
      expires: credentials.expires,
      email,
    })
    // OpenCode makes this login its active credential, so mark it primary.
    store.setPrimaryByRefresh(credentials.refresh)
  } catch {
    // Never block login on store/profile issues.
  }
}

export const AnthropicAuthPlugin: Plugin = async ({ client }) => {
  return {
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
          type Candidate = {
            id: string
            refresh: string
            access: string
            expires: number
            email?: string
          }

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
           * OpenCode, otherwise update the plugin-owned account store. For the
           * primary we ALSO update its stored copy (matched by the pre-rotation
           * refresh token) so the account stays usable after it's demoted.
           */
          async function persistTokens(
            id: string,
            tokens: { refresh: string; access: string; expires: number },
            oldRefresh?: string,
          ) {
            if (id === PRIMARY_ID) {
              // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose auth.set
              await (client as any).auth.set({
                path: { id: 'anthropic' },
                body: { type: 'oauth', ...tokens },
              })
              if (oldRefresh) store.updateTokensByRefresh(oldRefresh, tokens)
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
                await persistTokens(candidate.id, tokens, candidate.refresh)
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
              // Reflect the new primary in the store's `primary` flag.
              store.setPrimaryByRefresh(tokens.refresh)
            } catch {
              // Promotion is best-effort; never break the response over it.
            }
          }

          // Refresh tokens we've already tried to enrich with an email, so we
          // don't refetch the profile on every request. Keyed by refresh token
          // so it works for both store accounts and the primary slot.
          const enrichAttempted = new Set<string>()

          /**
           * Best-effort: resolve and store an email label for an account that
           * doesn't have one yet (e.g. accounts added before emails were
           * captured). Matched by refresh token so it also labels whichever
           * account currently occupies OpenCode's primary slot. Uses the
           * already-valid access token from the just-served request (no extra
           * refresh). Runs at most once per account per session; never throws.
           */
          async function enrichEmail(refresh: string, accessToken: string) {
            if (!refresh || !accessToken || enrichAttempted.has(refresh)) return
            enrichAttempted.add(refresh)
            // Only hit the profile endpoint if there's actually a store account
            // (without an email yet) that this would label.
            const target = store.list().find((a) => a.refresh === refresh)
            if (!target || target.email) return
            try {
              const profile = await fetchAccountProfile(accessToken)
              if (profile?.email) {
                store.setEmailByRefresh(refresh, profile.email)
                debugLog(`labeled account → ${profile.email}`)
              }
            } catch {
              // Ignore — labeling is cosmetic.
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
          }): Candidate[] {
            const candidates: Candidate[] = []
            const seen = new Set<string>()

            const now = Date.now()
            const all = store.list()

            if (current.refresh) {
              // If the primary account is also in the store, reuse its email.
              const known = all.find((a) => a.refresh === current.refresh)
              candidates.push({
                id: PRIMARY_ID,
                refresh: current.refresh,
                access: current.access ?? '',
                expires: current.expires ?? 0,
                email: known?.email,
              })
              seen.add(current.refresh)
            }

            // Tier 2: available store accounts.
            for (const account of all) {
              if (seen.has(account.refresh)) continue
              if (account.cooldownUntil && account.cooldownUntil > now) continue
              candidates.push({
                id: account.id,
                refresh: account.refresh,
                access: account.access,
                expires: account.expires,
                email: account.email,
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
                email: account.email,
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

              // Keep the store's `primary` flag pointing at whichever account
              // OpenCode currently holds (cheap; writes only when it changes).
              if (current.refresh) store.setPrimaryByRefresh(current.refresh)

              const candidates = buildCandidates(current)
              debugLog(
                `request: ${candidates.length} candidate account(s)`,
                candidates.map((c) =>
                  c.id === PRIMARY_ID
                    ? 'primary'
                    : (c.email ?? c.id.slice(0, 8)),
                ),
              )

              let body = init?.body
              if (body && typeof body === 'string') {
                body = rewriteRequestBody(body)
              } else if (body != null && candidates.length > 1) {
                // A non-string body (ReadableStream/Blob/BufferSource) can only
                // be consumed once. When failover is possible we buffer it up
                // front so each candidate can re-send the same bytes instead of
                // the first fetch draining it and the retries sending nothing.
                body = new Uint8Array(
                  // biome-ignore lint/suspicious/noExplicitAny: BodyInit is broad
                  await new Response(body as any).arrayBuffer(),
                )
              }
              const rewritten = rewriteUrl(input)

              let lastResponse: Response | undefined
              let lastError: unknown

              for (let i = 0; i < candidates.length; i++) {
                const candidate = candidates[i]
                if (!candidate) continue
                const isLast = i === candidates.length - 1
                const isPrimary = candidate.id === PRIMARY_ID
                const tag = isPrimary
                  ? 'primary'
                  : (candidate.email ?? candidate.id.slice(0, 8))

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
                // rate/usage limits, sometimes a few events in). We only inspect
                // the stream when failover is actually possible — i.e. this is a
                // streaming 2xx response AND another candidate remains to try.
                // This avoids adding first-token latency on the common
                // single-account path and never buffers the last candidate's (or
                // a non-streaming) response.
                if (response.ok && response.body && !isLast) {
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
                      `account ${tag}: stream error → failover → next account`,
                      prefixText.slice(0, 200),
                    )
                    lastResponse = rebuilt
                    await stream.cancel().catch(() => {})
                    continue
                  }

                  // Success. Self-heal: if a non-primary account served this,
                  // promote it into OpenCode's slot for subsequent requests.
                  if (!isPrimary) {
                    await promoteToPrimary(tokens)
                    debugLog(`account ${tag}: OK → promoted to primary`)
                  } else {
                    debugLog(`account ${tag}: OK`)
                  }
                  // Backfill an email label for accounts that lack one.
                  if (!candidate.email) {
                    void enrichEmail(candidate.refresh, tokens.access)
                  }
                  return createStrippedStream(rebuilt)
                }

                // Otherwise stream/return as-is (last candidate, non-streaming,
                // or a non-failover non-2xx error). Promote + label only on an
                // actual success so a passthrough error isn't treated as OK.
                if (response.ok) {
                  if (!isPrimary) {
                    await promoteToPrimary(tokens)
                    debugLog(`account ${tag}: OK → promoted to primary`)
                  } else {
                    debugLog(`account ${tag}: OK`)
                  }
                  if (!candidate.email) {
                    void enrichEmail(candidate.refresh, tokens.access)
                  }
                } else {
                  debugLog(
                    `account ${tag}: HTTP ${response.status} (passthrough)`,
                  )
                }
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
                // joins automatic failover. Run this method again and log in
                // with a DIFFERENT Claude account to add more — each login is
                // stored (deduped by refresh token, labeled by email) and
                // becomes the current primary account.
                if (credentials.type === 'success') {
                  await storeLoginAccount(credentials)
                }
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
