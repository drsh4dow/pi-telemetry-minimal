# pi-telemetry-minimal

Passive Pi token telemetry: one finalized assistant turn in, one usage record out.

Writes local JSONL by default. The prescribed way to consume the stream is [`pi-telemetry-web`](https://github.com/drsh4dow/pi-telemetry-web), a self-hosted SQLite dashboard that receives this package's webhook payload. You can still POST the same record to any compatible org webhook.

It never records prompts, responses, tool output, command text, file contents, or code snippets.

## Install

```bash
pi install npm:pi-telemetry-minimal
```

## Records

Each event is `schemaVersion: 1`, `type: "turn_usage"`.

Captured:

- timestamp, turn index
- session id/file, cwd/cwd name
- model api/provider/name
- input/output/cache tokens and provider-reported cost
- labels: team/project/developer
- git metadata: root, origin, branch, commit, user name/email

Default local sink:

```text
~/.pi/telemetry-minimal/events.jsonl
```

Webhook sink, when configured:

- `POST` one JSON record per turn
- body is the same object as local JSONL
- any 2xx is success
- optional `Authorization: Bearer <token>`
- 2000ms timeout by default
- best effort only: no retries, no queue, never blocks Pi

## Consume with pi-telemetry-web

Run [`pi-telemetry-web`](https://github.com/drsh4dow/pi-telemetry-web), create the first admin user, then copy the generated webhook URL and bearer token from its Settings page into `~/.pi/telemetry-minimal.json`:

```json
{
 "sinks": {
  "local": { "path": "~/.pi/telemetry-minimal/events.jsonl" },
  "webhook": {
   "url": "https://telemetry.example.com/api/telemetry/events",
   "token": "pi-telemetry-web-ingest-token",
   "timeoutMs": 2000
  }
 }
}
```

Existing local history can be imported in the dashboard by uploading:

```text
~/.pi/telemetry-minimal/events.jsonl
```

Keep the local sink enabled unless you intentionally want webhook-only telemetry.

## Configure

Full config example:

```json
{
 "enabled": true,
 "labels": {
  "team": "platform",
  "project": "pi",
  "developer": "dev@example.com"
 },
 "sinks": {
  "local": { "path": "~/.pi/telemetry-minimal/events.jsonl" },
  "webhook": {
   "url": "https://telemetry.example.com/api/telemetry/events",
   "token": "pi-telemetry-web-ingest-token",
   "timeoutMs": 2000
  }
 },
 "git": { "enabled": true, "timeoutMs": 750 },
 "warnOnError": true
}
```

Or env vars:

```bash
PI_TELEMETRY_ENABLED=true
PI_TELEMETRY_LOG_PATH=~/.pi/telemetry-minimal/events.jsonl
PI_TELEMETRY_TEAM=platform
PI_TELEMETRY_PROJECT=pi
PI_TELEMETRY_DEVELOPER=dev@example.com
PI_TELEMETRY_GIT=true
PI_TELEMETRY_GIT_TIMEOUT_MS=750
PI_TELEMETRY_WARN_ON_ERROR=true
PI_TELEMETRY_WEBHOOK_URL=https://telemetry.example.com/api/telemetry/events
PI_TELEMETRY_WEBHOOK_TOKEN=pi-telemetry-web-ingest-token
PI_TELEMETRY_WEBHOOK_TIMEOUT_MS=2000
```

Env wins over config. Boolean envs accept `true/false`, `1/0`, `yes/no`, `on/off`.

## Privacy + failure model

Webhook payloads mirror local records. If webhook is enabled, paths and git identity are sent to that backend.

Disable git metadata:

```json
{ "git": { "enabled": false } }
```

or:

```bash
PI_TELEMETRY_GIT=false
```

Failures degrade silently except for one warning when `warnOnError` is enabled.

## Development

```bash
bun install
bun test
bun run typecheck
bun run check
bun pm pack --dry-run
PI_OFFLINE=1 bunx --bun pi --no-extensions -e . --list-models >/tmp/pi-telemetry-minimal-pi-load.out
```
