# OpenCode Anthropic Auth Plugin

An [OpenCode](https://github.com/anomalyco/opencode) plugin that provides Anthropic OAuth authentication, enabling Claude Pro/Max users to use their subscription directly with OpenCode.

> [!NOTE]
> This package (`opencode-anthropic-auth-loocos`) is a fork of the upstream
> [`@ex-machina/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth)
> that adds **multiple-account support with automatic failover**. It is published
> independently and is not affiliated with the upstream maintainers.

> [!IMPORTANT]
> If you are seeing issues, please try to `rm -rf ~/.cache/opencode` and check your `opencode.json` config to make sure you're on the latest version.
>
> Try this FIRST before making an Issue. Thanks!

## Usage

Add the plugin to your OpenCode configuration:

```json
{
  "plugin": ["opencode-anthropic-auth-loocos"]
}
```

> [!TIP]
> It is STRONGLY advised that you pin the plugin to a version. This will keep you from getting automatic updates; however, this will protect you from nefarious updates.
>
> This holds true for ANY OpenCode plugin. If you do not pin them, OpenCode will automatically update them on startup. It's a massive vulnerability waiting to happen.

#### Example of pinned version

```json
{
  "plugin": ["opencode-anthropic-auth-loocos@1.9.2"]
}
```

## Authentication Methods

The plugin provides four authentication options:

- **Claude Pro/Max** - OAuth flow via `claude.ai` for Pro/Max subscribers. Uses your existing subscription at no additional API cost.
- **Add another Claude account (failover)** - OAuth flow to register an additional Claude account for automatic failover (see below).
- **Create an API Key** - OAuth flow via `console.anthropic.com` that creates an API key on your behalf.
- **Manually enter API Key** - Standard API key entry for users who already have one.

## Multiple Accounts & Automatic Failover

You can authenticate multiple Claude Pro/Max accounts and have the plugin
automatically switch between them when one runs out of usage.

### Adding accounts

1. Sign in normally via **Claude Pro/Max** (this becomes your primary account).
2. To add more accounts, choose **Add another Claude account (failover)** and
   complete the OAuth flow while logged into a *different* Claude account. Repeat
   for as many accounts as you want.

### How failover works

On every request the plugin builds an ordered list of candidate accounts and
tries them in turn:

1. Your primary (OpenCode) account first.
2. Then each additional account that isn't currently cooling down.
3. Then, as a **last resort**, accounts that *are* cooling down — so the
   session never stalls waiting for a human while an account might still work.

Failover triggers when a request fails in any of these ways:

- An HTTP error status: `429` (rate limit), `401`/`403` (auth), or `529`
  (overloaded).
- A **token refresh failure** such as `invalid_grant` (a logged-out / rotated
  refresh token). This is treated as that account being unavailable — the
  plugin moves on to the next account instead of surfacing the error.
- **An error *inside* a `200 OK` streaming response.** Claude Pro/Max usage
  limits frequently come back as HTTP 200 with an `error` event in the SSE
  stream (e.g. `rate_limit_error`), not as a `429`. The plugin inspects the
  stream up to the point real content begins — so even an error that arrives a
  few events in (after `message_start`) triggers failover. This is the common
  "my account got restricted mid-session" scenario.

The exhausted account is put on a cooldown (respecting any `Retry-After`
header) and the same request is transparently retried on the next account. An
error is only surfaced to you once **every** account has failed.

**Self-healing primary:** when a non-primary account serves a request because
the primary failed (e.g. the primary's refresh token died), that working
account is promoted into OpenCode's own credential slot. Subsequent requests
then start from a healthy account instead of retrying the dead primary every
time.

Access tokens are refreshed per account, and rotated refresh tokens are
persisted automatically. Cooldowns expire on their own, so an account becomes
available again after its rate-limit window passes. An account whose refresh
token is permanently invalid (e.g. logged out elsewhere) is cooled down for an
hour so it stops being retried on every request.

### Debugging failover

Set `ANTHROPIC_FAILOVER_DEBUG=1` to log candidate selection and failover
decisions to stderr, e.g.:

```
[anthropic-failover] request: 3 candidate account(s) [ 'primary', 'd88cbd5a', 'd5189abb' ]
[anthropic-failover] account primary: stream error → failover
[anthropic-failover] account d88cbd5a: OK
```

### Where accounts are stored

Additional accounts are stored in a plugin-owned JSON file (mode `0600`):

- `$ANTHROPIC_ACCOUNTS_PATH` if set, otherwise
- `$XDG_DATA_HOME/opencode-anthropic-auth/accounts.json`, otherwise
- `~/.local/share/opencode-anthropic-auth/accounts.json`

To remove an account, delete its entry from that file (or delete the file to
reset all extra accounts). Your primary account continues to be managed by
OpenCode's own credential store.

## Configuration

The plugin supports the following environment variables:

| Variable                          | Description                                                                                                                                                                                 |
|-----------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `ANTHROPIC_BASE_URL`              | Override the API endpoint URL (e.g. for proxying). Must be a valid HTTP(S) URL.                                                                                                             |
| `ANTHROPIC_INSECURE`              | Set to `1` or `true` to skip TLS certificate verification. Only effective when `ANTHROPIC_BASE_URL` is also set.                                                                            |
| `ANTHROPIC_ACCOUNTS_PATH`         | Override the path to the multi-account store file. Defaults to `$XDG_DATA_HOME/opencode-anthropic-auth/accounts.json` (or `~/.local/share/...`).                                            |
| `ANTHROPIC_FAILOVER_DEBUG`        | Set to `1` or `true` to log multi-account candidate selection and failover decisions to stderr.                                                                                             |

## How It Works

For Claude Pro/Max authentication, the plugin:

1. Initiates a PKCE OAuth flow against Anthropic's authorization endpoint
2. Exchanges the authorization code for access and refresh tokens
3. Automatically refreshes expired tokens (per account)
4. Injects the required OAuth headers and beta flags into API requests
5. Sanitizes the system prompt for compatibility (see below)
6. Zeros out model costs (since usage is covered by the subscription)
7. Automatically fails over to another authenticated account when one is
   rate-limited or exhausted (see [Multiple Accounts & Automatic Failover](#multiple-accounts--automatic-failover))

### System Prompt Sanitization

The Anthropic API for Max subscriptions has specific requirements for the system prompt to identify as Claude Code. The plugin rewrites the system prompt on each request using an **anchor-based** approach that minimizes what gets changed:

1. **Identity swap** — The OpenCode identity line is removed and replaced with the Claude Code identity.
2. **Paragraph removal by anchor** — Any paragraph containing a known URL anchor (e.g. `github.com/anomalyco/opencode`, `opencode.ai/docs`) is removed entirely. This is resilient to upstream rewording — as long as the anchor URL appears somewhere in the paragraph, the removal works regardless of surrounding text changes.
3. **Inline text replacements** — Short branded strings inside paragraphs we want to keep are replaced (e.g. "OpenCode" → "the assistant" in the professional objectivity section).

Everything else in the system prompt is preserved: tone/style guidance, task management instructions, tool usage policy, environment info, skills, user/project instructions, and file paths containing "opencode". The sanitized system prompt is structured as three blocks in `system[]`: the billing header, the Claude Code identity line, and the remaining system content.

## Development

### Local Testing

Use `bun run dev` to test plugin changes locally without publishing to npm:

```bash
bun run dev
```

This does three things:

1. Builds the plugin
2. Symlinks the build output into `.opencode/plugins/` so OpenCode loads it as a local plugin
3. Starts `tsc --watch` for automatic rebuilds on source changes

After starting the dev script, restart OpenCode in this project directory to pick up the local build. Any edits to `src/` will trigger a rebuild — restart OpenCode again to load the new version.

Ctrl+C stops the watcher and cleans up the symlink. If the process was killed without cleanup (e.g. `kill -9`), you can manually remove the symlink:

```bash
bun run dev:clean
```

> [!NOTE]
> If you have the npm version of this plugin in your global OpenCode config, both will load. The local version takes precedence for auth handling.

### Publishing

This project uses [changesets](https://github.com/changesets/changesets) for versioning and publishing. See the [changeset README](.changeset/README.md) for more details.

```bash
bun change          # create a changeset describing your changes
```

When changesets are merged to `main`, CI will automatically open a release PR. Merging that PR publishes to npm.

## License

MIT
