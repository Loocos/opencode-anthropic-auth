import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AccountStore,
  computeCooldownUntil,
  isFailoverStatus,
} from '../accounts'

let dir: string
let storePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-test-'))
  storePath = join(dir, 'accounts.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('AccountStore', () => {
  test('starts empty when file does not exist', () => {
    const store = new AccountStore(storePath)
    expect(store.list()).toEqual([])
    expect(store.available()).toEqual([])
  })

  test('add creates a file with the account', () => {
    const store = new AccountStore(storePath)
    const account = store.add({
      refresh: 'r1',
      access: 'a1',
      expires: 123,
    })
    expect(existsSync(storePath)).toBe(true)
    expect(account.id).toBeString()
    expect(account.label).toBe('Account 1')
    expect(store.list()).toHaveLength(1)
  })

  test('add dedupes by refresh token and updates tokens', () => {
    const store = new AccountStore(storePath)
    const first = store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    const second = store.add({ refresh: 'r1', access: 'a2', expires: 2 })
    expect(store.list()).toHaveLength(1)
    expect(second.id).toBe(first.id)
    expect(store.list()[0]!.access).toBe('a2')
    expect(store.list()[0]!.expires).toBe(2)
  })

  test('add assigns incrementing default labels', () => {
    const store = new AccountStore(storePath)
    store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    const second = store.add({ refresh: 'r2', access: 'a2', expires: 2 })
    expect(second.label).toBe('Account 2')
  })

  test('remove deletes an account by id', () => {
    const store = new AccountStore(storePath)
    const account = store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    expect(store.remove(account.id)).toBe(true)
    expect(store.list()).toHaveLength(0)
    expect(store.remove('missing')).toBe(false)
  })

  test('updateTokens rotates tokens and clears cooldown', () => {
    const store = new AccountStore(storePath)
    const account = store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    store.markCooldown(account.id, Date.now() + 100_000, 'rate limited')
    store.updateTokens(account.id, {
      refresh: 'r2',
      access: 'a2',
      expires: 999,
    })
    const updated = store.list()[0]!
    expect(updated.refresh).toBe('r2')
    expect(updated.access).toBe('a2')
    expect(updated.expires).toBe(999)
    expect(updated.cooldownUntil).toBe(0)
    expect(updated.lastError).toBeUndefined()
  })

  test('markCooldown removes account from available until it expires', () => {
    const store = new AccountStore(storePath)
    const account = store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    const now = Date.now()
    store.markCooldown(account.id, now + 60_000, 'HTTP 429')

    expect(store.available(now)).toHaveLength(0)
    // After cooldown elapses it becomes available again.
    expect(store.available(now + 61_000)).toHaveLength(1)
  })

  test('tolerates corrupt json without throwing', () => {
    const store = new AccountStore(storePath)
    store.add({ refresh: 'r1', access: 'a1', expires: 1 })
    // Corrupt the file.
    require('node:fs').writeFileSync(storePath, '{ not json', 'utf8')
    expect(store.list()).toEqual([])
  })
})

describe('computeCooldownUntil', () => {
  test('uses retry-after seconds', () => {
    const now = 1_000_000
    expect(computeCooldownUntil('30', now)).toBe(now + 30_000)
  })

  test('uses retry-after http-date', () => {
    const now = Date.parse('2030-01-01T00:00:00Z')
    const future = new Date(now + 45_000).toUTCString()
    expect(computeCooldownUntil(future, now)).toBe(Date.parse(future))
  })

  test('falls back to default when absent', () => {
    const now = 1_000_000
    expect(computeCooldownUntil(null, now, 60_000)).toBe(now + 60_000)
  })

  test('falls back to default when unparseable', () => {
    const now = 1_000_000
    expect(computeCooldownUntil('not-a-number', now, 60_000)).toBe(now + 60_000)
  })
})

describe('isFailoverStatus', () => {
  test('treats 429/401/403/529 as failover', () => {
    expect(isFailoverStatus(429)).toBe(true)
    expect(isFailoverStatus(401)).toBe(true)
    expect(isFailoverStatus(403)).toBe(true)
    expect(isFailoverStatus(529)).toBe(true)
  })

  test('treats 200/400/500 as non-failover', () => {
    expect(isFailoverStatus(200)).toBe(false)
    expect(isFailoverStatus(400)).toBe(false)
    expect(isFailoverStatus(500)).toBe(false)
  })
})
