# pi-telemetry-minimal

Minimal passive telemetry for Pi token usage.

It records provider-reported assistant token usage after each completed turn and appends one JSON object per line to a local file. No prompts, responses, tool outputs, file contents, or code snippets are written.

## Install

```bash
pi install npm:pi-telemetry-minimal
```

## What it records

Each record has `schemaVersion: 1` and `type: "turn_usage"`.

Included:

- timestamp
- turn index
- session id and session file
- cwd and cwd basename
- provider, API, and model from the assistant message
- input/output/cache token usage and reported cost
- optional configured labels: team, project, developer
- best-effort git metadata: repo root, origin remote, branch, commit, raw git user name/email

Not included:

- prompt text
- assistant response text
- tool output
- file contents
- command contents

## Output

Default JSONL path:

```text
~/.pi/telemetry-minimal/events.jsonl
```

Example shape:

```json
{"schemaVersion":1,"type":"turn_usage","timestamp":"2026-04-27T00:00:00.000Z","turn":{"index":1},"session":{"id":"...","file":"...","cwd":"/repo","cwdName":"repo"},"model":{"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5"},"labels":{"project":"repo","developer":"dev@example.com"},"git":{"root":"/repo","remote":"git@github.com:org/repo.git","branch":"main","commit":"...","userName":"Dev","userEmail":"dev@example.com"},"usage":{"input":100,"output":25,"cacheRead":0,"cacheWrite":0,"totalTokens":125,"cost":{"input":0.001,"output":0.002,"cacheRead":0,"cacheWrite":0,"total":0.003}}}
```

## Config

Config file:

```text
~/.pi/telemetry-minimal.json
```

Supported fields:

```json
{
	"enabled": true,
	"logPath": "~/.pi/telemetry-minimal/events.jsonl",
	"team": "platform",
	"project": "pi",
	"developer": "dev@example.com",
	"collectGit": true,
	"warnOnError": true,
	"gitTimeoutMs": 750
}
```

Environment variables override config file values:

- `PI_TELEMETRY_ENABLED`
- `PI_TELEMETRY_LOG_PATH`
- `PI_TELEMETRY_TEAM`
- `PI_TELEMETRY_PROJECT`
- `PI_TELEMETRY_DEVELOPER`
- `PI_TELEMETRY_GIT`
- `PI_TELEMETRY_WARN_ON_ERROR`
- `PI_TELEMETRY_GIT_TIMEOUT_MS`

Boolean env values accept `true/false`, `1/0`, `yes/no`, and `on/off`.

## Privacy

Git metadata is enabled by default and records raw `git config user.name` and `git config user.email` when available. Disable it with:

```json
{ "collectGit": false }
```

or:

```bash
PI_TELEMETRY_GIT=false
```

Telemetry failures never block Pi. Failed writes or git lookups degrade silently except for at most one warning when warnings are enabled.

## Development

```bash
bun install
bun test
bun run typecheck
bun run check
bun pm pack --dry-run
PI_OFFLINE=1 bunx --bun pi --no-extensions -e . --list-models >/tmp/pi-telemetry-minimal-pi-load.out
```
