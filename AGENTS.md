# pi-telemetry-minimal

A tiny passive Pi package for token usage telemetry.

Do not add LLM-callable tools, UI workflows, dashboards, or broad analytics logic. Keep the extension passive: collect finalized assistant usage and append JSONL records.

## Bun-first workflow

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`.
- Use `bun test` instead of Jest/Vitest.
- Use `bun run <script>` instead of npm/yarn/pnpm script runners.
- Use `bunx <package> <command>` instead of `npx`.
- Bun automatically loads `.env`; do not add dotenv.

## Validation

Run before claiming ready:

```bash
bun test
bun run typecheck
bun run check
bun pm pack --dry-run
PI_OFFLINE=1 bunx --bun pi --no-extensions -e . --list-models >/tmp/pi-telemetry-minimal-pi-load.out
```
