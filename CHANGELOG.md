# opencode-anthropic-auth-loocos

> Forked from [`@ex-machina/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth).
> Entries below version 1.9.0 are from the upstream project.

## 1.13.0

### Minor Changes

- Add an `anthropic-add-account` CLI (`bun run add-account`) for adding accounts to the failover pool **without interrupting running OpenCode sessions**. Adding an account through OpenCode's built-in Claude Pro/Max login makes OpenCode re-initialize the `anthropic` provider, which stops whatever session is currently generating. The new CLI runs the same OAuth flow but writes only to the plugin's own account store — it never touches OpenCode's credential slot, so active sessions keep working. The added account (deduped by email, not marked primary) is available for failover on the next request.

## 1.12.0

### Minor Changes

- Deduplicate accounts by email. Logging into the **same** Claude account more than once used to create multiple entries (each login has a different refresh token) that all shared one usage quota — so failover between them did nothing. The store now collapses logins of the same account (same email) down to a single entry, keeping the primary (or freshest) one. This happens on login and whenever an account's email is resolved, so the pool reflects your *distinct* Claude accounts.

## 1.11.0

### Minor Changes

- Remove the separate "Add another Claude account (failover)" entry from the OpenCode auth menu — it's back to the original three options. Failover is now fully transparent: signing in with **Claude Pro/Max** repeatedly (each time with a different Claude account) adds every account to the failover pool automatically.
- Record which account is currently primary in `accounts.json` via a `primary: true` flag on the single account held in OpenCode's credential slot. The flag follows the active account as it changes (login, failover promotion, token rotation). To keep it accurate, a stored account's tokens are now also kept in sync when OpenCode rotates the primary's refresh token, so a demoted account remains usable.

## 1.10.0

### Minor Changes

- Label stored accounts by their Claude email address instead of "Account 1/2/3". The email is captured from the OAuth token response at login, or resolved from the `GET /api/oauth/profile` endpoint (the `user:profile` scope) when the token response doesn't include it. Existing accounts are backfilled lazily the first time they successfully serve a request. Emails now appear in the account store (`accounts.json`) and in `ANTHROPIC_FAILOVER_DEBUG` logs, so you can tell which account is which and which one hit a limit.

## 1.9.2

### Patch Changes

- Make failover actually switch accounts for `invalid_grant` and usage limits instead of stopping the session. Three fixes: (1) **A dead/rate-limited primary no longer surfaces `invalid_grant` to you** — the plugin now tries every other account (including ones currently cooling down, as a last resort) before ever showing an error, and only throws when literally every account has failed. (2) **Self-healing primary** — when another account serves a request because the primary failed, that account is promoted into OpenCode's credential slot, so subsequent requests start from a healthy account instead of retrying the dead one. (3) **Mid-stream error detection** — the plugin now inspects the response until real content begins, so a `rate_limit_error` that arrives a few SSE events in (after `message_start`) still triggers failover instead of being streamed to you as a broken response.

## 1.9.1

### Patch Changes

- Fix failover not triggering for Claude Pro/Max usage limits. Anthropic often returns **HTTP 200 with an `error` event inside the SSE stream** (e.g. `rate_limit_error`) rather than a `429` status, so the previous status-only check never failed over. The plugin now peeks at the start of the response stream and fails over when it detects a rate-limit / usage-limit / overloaded / auth error in the body (SSE or JSON), in addition to the HTTP `429/401/403/529` statuses. Dead refresh tokens now cool down for 1 hour instead of retrying every 5 minutes. Added an opt-in `ANTHROPIC_FAILOVER_DEBUG=1` env var that logs candidate selection and failover decisions to stderr.

## 1.9.0

### Minor Changes

- Add multiple Claude account support with automatic failover. You can now authenticate several Claude Pro/Max accounts via a new "Add another Claude account (failover)" auth method; extra accounts are stored in a plugin-owned `accounts.json` (path overridable via `ANTHROPIC_ACCOUNTS_PATH`). When a request hits a rate limit / usage limit / auth error (`429`, `401`, `403`, `529`), the plugin transparently retries it on the next available account and puts the exhausted account on a cooldown (respecting `Retry-After`), only surfacing an error once every account is exhausted.

- Add Claude Opus 4.7 to the model selection list via a new `provider` hook. The plugin now injects `claude-opus-4-7` into the Anthropic provider's model map if it's not already present in OpenCode's bundled models.dev snapshot, so users can select the newly released model without waiting for an OpenCode update.

## 1.7.3

### Patch Changes

- [#110](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/110) [`2352c87`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/2352c875bdbbb740b9faecd0345c2af88b993e58) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Downgrade bun to 1.3.11 to work around a macOS code-signing issue in 1.3.12 that prevents dev-mode testing.

## 1.7.2

### Patch Changes

- [#106](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/106) [`31b3b99`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/31b3b991be07dbc27734bc8326e3d8fe0d3626ac) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Bump bun to 1.3.12, ensure we use mise in CI, and lock engines for dev

## 1.7.1

### Patch Changes

- [#94](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/94) [`522c18d`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/522c18d7193d2a99d28e2664b0ba2b10faf80a4c) Thanks [@colus001](https://github.com/colus001)! - Fix `Cannot find module '.../dist/auth'` error when opencode loads the plugin as strict ESM.

## 1.7.0

### Minor Changes

- [#91](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/91) [`550c408`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/550c408e22f29ee83fe9c707318e8759510ff0eb) Thanks [@bogdan-manole](https://github.com/bogdan-manole)! - fixing the StructuredOutput issue introduced in v1.5.1

## 1.6.1

### Patch Changes

- [#88](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/88) [`a90185a`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/a90185afc77f8200d3a2187b244610eef7375371) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Remove system block to user message relocation, remove experimental FF, and align system blocks to match Anthropic

- [#87](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/87) [`e3e1be4`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/e3e1be4aace9d34bda53a99d43b9c72afbf6d6a4) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Remove OpenCode identity more accurately

## 1.6.0

### Minor Changes

- [#81](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/81) [`0906d28`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/0906d288b85511abcba358ccdec04ae2929792ae) Thanks [@INONONO66](https://github.com/INONONO66)! - PascalCase tool names after mcp\_ prefix to match Claude Code convention

## 1.5.1

### Patch Changes

- [#76](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/76) [`d92609c`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/d92609c2c8168f9b80616f0269381126a02fe7c8) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Add in `EXPERIMENTAL_KEEP_SYSTEM_PROMPT` which allows users to
  keep the sanitized prompt as a system prompt, instead of changing
  it to a user propmt.

## 1.5.0

### Minor Changes

- [#74](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/74) [`53b62bb`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/53b62bb1fc18fff29fccbfa0ef190d5082cc247d) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Add in Claude billing header with content consistency hashing from decompiled binary

## 1.4.1

### Patch Changes

- [#70](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/70) [`91601b8`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/91601b81616b5013517d316c82beb5c3d6303022) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps-dev): bump @opencode-ai/plugin from 1.3.13 to 1.4.3

- [#71](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/71) [`ce3f9fc`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/ce3f9fc0f96c943c5ec3b906e4285bedababae2e) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps-dev): bump lefthook from 2.1.4 to 2.1.5

- [#69](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/69) [`2d9b5bc`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/2d9b5bce197464504c2957b7943344291e559f4b) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps-dev): bump @biomejs/biome from 2.4.10 to 2.4.11

## 1.4.0

### Minor Changes

- [#63](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/63) [`69f4754`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/69f4754b7b59ed6632e5d0db30f92ccc3d3beb39) Thanks [@eXamadeus](https://github.com/eXamadeus)! - To bypass Anthropic's scans of the system prompts, move all but the identity marker into a user message

### Patch Changes

- [#61](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/61) [`8dca525`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/8dca5253cedbce8bc1d1283368370044ff933321) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Minor change to identity anchor

## 1.3.0

### Minor Changes

- [#59](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/59) [`d520d0c`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/d520d0ceb27bcab25c36a85925b71212d2721f24) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Minimize prompt sanitization reach with anchor-based paragraph removal, preserving behavioral guidance that was previously stripped.

## 1.2.0

### Minor Changes

- [#52](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/52) [`19ea91a`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/19ea91abdfa04506fccf6c24cce1dabccb82f98a) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Add system prompt sanitization for Max subscription compatibility. Moves system prompt handling from the plugin hook into the request body layer, surgically removing the OpenCode identity section and prepending Claude Code identity. Preserves user-configured instructions from config.json.

## 1.1.2

### Patch Changes

- [#49](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/49) [`3ad9267`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/3ad92670bcc77adb45eab51efeab7ffcc7537822) Thanks [@PaoloC68](https://github.com/PaoloC68)! - Surface token refresh error body for easier diagnosis; add prepare script for github installs

## 1.1.1

### Patch Changes

- [#47](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/47) [`c0fbbcf`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/c0fbbcf6cdcf6c2879604e0b8e609cbdf8fddead) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Minor bump to update README in npm with security suggestion

## 1.1.0

### Minor Changes

- [#42](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/42) [`feec332`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/feec3328afd0c9fcc5b708f5d2b11337e6844242) Thanks [@Thesam1798](https://github.com/Thesam1798)! - feat: support ANTHROPIC_BASE_URL env var for custom API endpoint

## 1.0.4

### Patch Changes

- [#39](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/39) [`32240f1`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/32240f1e82e2ec711e9699a4efecb754e192c3af) Thanks [@Thesam1798](https://github.com/Thesam1798)! - ci: harden workflows for fork safety and concurrency

- [#41](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/41) [`386e716`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/386e71681d00c858e0d0fe958a06f3ee3fab10e3) Thanks [@Thesam1798](https://github.com/Thesam1798)! - fix: deduplicate concurrent OAuth token refreshes

## 1.0.3

### Patch Changes

- [#37](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/37) [`97729bc`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/97729bc8140f9931512958bda2de6950a4ce4636) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Update copyright year in LICENSE file

## 1.0.2

### Patch Changes

- [#31](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/31) [`2ff263f`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/2ff263f9d8c43ed009582697a45f4dfbf6de4e0b) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Add in changesets for changeset management and fix type checking

- [#33](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/33) [`4523f1b`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/4523f1beba4f6c2669a04e67a47be8d365d0d30f) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Make sure changeset PRs are run by bot user for CI to trigger

- [#34](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/34) [`9c7a9e2`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/9c7a9e217a0c6be0f419bf129dad48c033120da5) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Ensure CI is triggered per release
