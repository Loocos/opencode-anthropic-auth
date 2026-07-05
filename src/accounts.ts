import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * A single stored Claude OAuth account.
 *
 * The token fields (`refresh`, `access`, `expires`) mirror the shape produced
 * by the OAuth exchange/refresh flow and stored by OpenCode for the `anthropic`
 * provider, so the existing refresh logic works unchanged per account.
 */
export type Account = {
  /** Stable unique id (used for dedup + as a stable handle). */
  id: string
  /** Human-friendly label shown in logs/UI (e.g. "Account 1"). */
  label: string
  refresh: string
  access: string
  /** Epoch ms when the access token expires. */
  expires: number
  /**
   * Epoch ms until which this account is skipped for selection because it hit
   * a rate limit / usage limit. `0` (or absent) means available.
   */
  cooldownUntil?: number
  /** Last error message recorded for this account (diagnostics only). */
  lastError?: string
}

type AccountStoreFile = {
  version: 1
  accounts: Account[]
}

const ENV_STORE_PATH = 'ANTHROPIC_ACCOUNTS_PATH'

/**
 * Resolve the accounts file path.
 *
 * Precedence:
 *  1. `ANTHROPIC_ACCOUNTS_PATH` env var (used by tests and power users)
 *  2. `$XDG_DATA_HOME/opencode-anthropic-auth/accounts.json`
 *  3. `~/.local/share/opencode-anthropic-auth/accounts.json`
 */
export function resolveStorePath(): string {
  const override = process.env[ENV_STORE_PATH]?.trim()
  if (override) return override

  const xdg = process.env.XDG_DATA_HOME?.trim()
  const base = xdg || join(homedir(), '.local', 'share')
  return join(base, 'opencode-anthropic-auth', 'accounts.json')
}

function emptyStore(): AccountStoreFile {
  return { version: 1, accounts: [] }
}

function readStore(path: string): AccountStoreFile {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // Missing file (or unreadable) → treat as empty store.
    return emptyStore()
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AccountStoreFile>
    if (!parsed || !Array.isArray(parsed.accounts)) return emptyStore()
    // Filter to well-formed account entries defensively.
    const accounts = parsed.accounts.filter(
      (a): a is Account =>
        !!a &&
        typeof a.id === 'string' &&
        typeof a.refresh === 'string' &&
        typeof a.access === 'string' &&
        typeof a.expires === 'number',
    )
    return { version: 1, accounts }
  } catch {
    // Corrupt JSON → don't crash the plugin; start fresh.
    return emptyStore()
  }
}

function writeStore(path: string, store: AccountStoreFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  const data = JSON.stringify(store, null, 2)
  // Write to a temp file then rename for atomicity (avoids torn writes when
  // multiple OpenCode sessions persist tokens concurrently).
  writeFileSync(tmp, data, { mode: 0o600 })
  // node:fs renameSync is atomic on the same filesystem.
  renameSync(tmp, path)
}

/**
 * File-backed store for multiple Claude OAuth accounts.
 *
 * All mutations re-read the file first (merge semantics) so concurrent
 * OpenCode sessions don't clobber each other's account list.
 */
export class AccountStore {
  private readonly path: string

  constructor(path: string = resolveStorePath()) {
    this.path = path
  }

  /** Return all accounts (as stored). */
  list(): Account[] {
    return readStore(this.path).accounts
  }

  /**
   * Add or replace an account. Dedupes by refresh token so re-authenticating
   * the same Claude account updates the existing entry instead of duplicating.
   * Returns the stored account (with assigned id/label).
   */
  add(input: {
    refresh: string
    access: string
    expires: number
    label?: string
  }): Account {
    const store = readStore(this.path)

    const existing = store.accounts.find((a) => a.refresh === input.refresh)
    if (existing) {
      existing.access = input.access
      existing.refresh = input.refresh
      existing.expires = input.expires
      existing.cooldownUntil = 0
      existing.lastError = undefined
      if (input.label) existing.label = input.label
      writeStore(this.path, store)
      return existing
    }

    const account: Account = {
      id: crypto.randomUUID(),
      label: input.label ?? `Account ${store.accounts.length + 1}`,
      refresh: input.refresh,
      access: input.access,
      expires: input.expires,
      cooldownUntil: 0,
    }
    store.accounts.push(account)
    writeStore(this.path, store)
    return account
  }

  /** Remove an account by id. Returns true if something was removed. */
  remove(id: string): boolean {
    const store = readStore(this.path)
    const before = store.accounts.length
    store.accounts = store.accounts.filter((a) => a.id !== id)
    if (store.accounts.length === before) return false
    writeStore(this.path, store)
    return true
  }

  /**
   * Persist rotated tokens for an account after a successful refresh.
   * No-op if the account no longer exists.
   */
  updateTokens(
    id: string,
    tokens: { refresh: string; access: string; expires: number },
  ): void {
    const store = readStore(this.path)
    const account = store.accounts.find((a) => a.id === id)
    if (!account) return
    account.refresh = tokens.refresh
    account.access = tokens.access
    account.expires = tokens.expires
    account.cooldownUntil = 0
    account.lastError = undefined
    writeStore(this.path, store)
  }

  /**
   * Mark an account as cooling down (rate-limited / usage-limited) until the
   * given epoch-ms timestamp. Selection skips it until then.
   */
  markCooldown(id: string, until: number, reason?: string): void {
    const store = readStore(this.path)
    const account = store.accounts.find((a) => a.id === id)
    if (!account) return
    account.cooldownUntil = until
    if (reason) account.lastError = reason
    writeStore(this.path, store)
  }

  /**
   * Return accounts eligible for use right now (cooldown expired), ordered so
   * the caller can try them in sequence. Accounts whose cooldown has naturally
   * elapsed are considered available again.
   */
  available(now: number = Date.now()): Account[] {
    return readStore(this.path).accounts.filter(
      (a) => !a.cooldownUntil || a.cooldownUntil <= now,
    )
  }
}

/**
 * Parse a `retry-after` header (seconds or HTTP-date) into an epoch-ms
 * timestamp. Falls back to `defaultMs` from `now` when absent/unparseable.
 */
export function computeCooldownUntil(
  retryAfter: string | null,
  now: number = Date.now(),
  defaultMs = 60_000,
): number {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return now + seconds * 1000
    }
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) {
      return Math.max(date, now)
    }
  }
  return now + defaultMs
}

/**
 * Decide whether an Anthropic API response status indicates the current
 * account is exhausted and we should fail over to another account.
 *
 * - 429: rate limit / usage limit
 * - 401/403: auth rejected (token invalid, subscription issue)
 * - 529: Anthropic "overloaded" (treated as transient exhaustion)
 */
export function isFailoverStatus(status: number): boolean {
  return status === 429 || status === 401 || status === 403 || status === 529
}
