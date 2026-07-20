#!/usr/bin/env node
/**
 * Standalone "add a Claude account to the failover pool" CLI.
 *
 * Why this exists: adding an account through OpenCode's built-in auth login
 * command makes OpenCode re-initialize the `anthropic` provider, which
 * interrupts any AI session that is currently generating. This tool runs the
 * same OAuth flow but writes the new account ONLY to the plugin's own account
 * store (`accounts.json`) — it never touches OpenCode's credential slot, so
 * running OpenCode sessions keep working uninterrupted. The plugin reads the
 * store fresh on every request, so the account joins failover immediately.
 *
 * Usage:
 *   node dist/add-account.js         (or: bun src/add-account.ts)
 *
 * The account is added to the pool but is NOT made the active/primary account,
 * so your current session's account is left untouched.
 */
import * as readline from 'node:readline/promises'
import { AccountStore } from './accounts.ts'
import { authorize, exchange } from './auth.ts'
import { fetchAccountProfile } from './profile.ts'

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  try {
    const auth = await authorize('max')

    process.stdout.write(
      [
        '',
        'Add a Claude Pro/Max account to the failover pool.',
        '',
        '1. Open this URL in your browser and log in with the account you want',
        '   to ADD (use a DIFFERENT Claude account than the ones you already',
        '   have if you want real failover):',
        '',
        `   ${auth.url}`,
        '',
        '2. After authorizing, copy the code shown (it looks like `code#state`).',
        '',
      ].join('\n'),
    )

    const code = (
      await rl.question('Paste the authorization code here: ')
    ).trim()
    if (!code) {
      process.stderr.write('No code provided. Aborting.\n')
      process.exitCode = 1
      return
    }

    const credentials = await exchange(
      code,
      auth.verifier,
      auth.redirectUri,
      auth.state,
    )

    if (credentials.type !== 'success') {
      process.stderr.write(
        'Authorization failed. Double-check the code and try again.\n',
      )
      process.exitCode = 1
      return
    }

    // Resolve the account email (from the token response, else the profile).
    let email = credentials.email
    if (!email) {
      const profile = await fetchAccountProfile(credentials.access)
      email = profile?.email
    }

    const store = new AccountStore()
    const before = store.list().length
    const account = store.add({
      refresh: credentials.refresh,
      access: credentials.access,
      expires: credentials.expires,
      email,
    })
    // NOTE: intentionally NOT marked primary — we don't change OpenCode's active
    // account, so running sessions are undisturbed.
    const after = store.list().length

    const distinctNote =
      after === before
        ? ' (this account was already in the pool — refreshed it)'
        : ''

    process.stdout.write(
      [
        '',
        `✓ Added ${account.email ?? account.label} to the failover pool${distinctNote}.`,
        `  The pool now has ${after} distinct account(s).`,
        '  Your current OpenCode session was not touched.',
        '',
      ].join('\n'),
    )
  } finally {
    rl.close()
  }
}

main().catch((error) => {
  process.stderr.write(
    `Failed to add account: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  )
  process.exitCode = 1
})
