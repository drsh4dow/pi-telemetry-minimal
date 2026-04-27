import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	TurnEndEvent,
} from "@mariozechner/pi-coding-agent";
import telemetryExtension, {
	buildTurnUsageRecord,
	CONFIG_PATH,
	DEFAULT_LOG_PATH,
	extractAssistantUsage,
	handleTurnEnd,
	loadTelemetryConfig,
	type TelemetryConfig,
	type TelemetrySink,
	writeJsonl,
} from "./extensions/telemetry-minimal.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { force: true, recursive: true });
	}
});

async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), "pi-telemetry-minimal-test-"));
	tempDirs.push(dir);
	return dir;
}

function assistant(
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "SECRET RESPONSE" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 100,
			output: 25,
			cacheRead: 10,
			cacheWrite: 5,
			totalTokens: 140,
			cost: {
				input: 0.001,
				output: 0.002,
				cacheRead: 0.0001,
				cacheWrite: 0.0002,
				total: 0.0033,
			},
		},
		stopReason: "stop",
		timestamp: 1710000000000,
		...overrides,
	};
}

function context(cwd: string): ExtensionContext {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => "/tmp/session.jsonl",
		},
	} as unknown as ExtensionContext;
}

function config(overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
	return {
		enabled: true,
		logPath: DEFAULT_LOG_PATH,
		collectGit: true,
		warnOnError: true,
		gitTimeoutMs: 750,
		...overrides,
	};
}

describe("pi-telemetry-minimal extension", () => {
	test("registers only passive turn tracking", () => {
		const events: string[] = [];
		telemetryExtension({
			on(event: string) {
				events.push(event);
			},
			registerTool() {
				throw new Error("telemetry should not expose LLM tools");
			},
		} as unknown as ExtensionAPI);

		expect(events).toEqual(["turn_end"]);
	});

	test("package metadata follows Pi package conventions", async () => {
		const pkg = (await Bun.file("package.json").json()) as {
			exports?: string;
			files?: string[];
			pi?: { extensions?: string[] };
			peerDependencies?: Record<string, string>;
		};

		expect(pkg.exports).toBe("./index.ts");
		expect(pkg.pi?.extensions).toEqual(["./extensions/telemetry-minimal.ts"]);
		expect(pkg.files).toEqual(["extensions", "index.ts", "README.md"]);
		expect(pkg.peerDependencies).toEqual({
			"@mariozechner/pi-ai": "*",
			"@mariozechner/pi-coding-agent": "*",
			"@mariozechner/pi-tui": "*",
		});
	});
});

describe("configuration", () => {
	test("defaults to enabled local JSONL telemetry", () => {
		const cfg = loadTelemetryConfig({
			env: {},
			configPath: "/tmp/does-not-exist-pi-telemetry-minimal.json",
		});

		expect(CONFIG_PATH).toEndWith("/.pi/telemetry-minimal.json");
		expect(cfg.enabled).toBe(true);
		expect(cfg.logPath).toBe(DEFAULT_LOG_PATH);
		expect(cfg.collectGit).toBe(true);
		expect(cfg.warnOnError).toBe(true);
	});

	test("uses config file with env overrides", async () => {
		const dir = await tempDir();
		const configPath = join(dir, "config.json");
		await Bun.write(
			configPath,
			JSON.stringify({
				enabled: false,
				logPath: "/from-config.jsonl",
				team: "platform",
				project: "agent",
				developer: "config-dev",
				collectGit: false,
				warnOnError: false,
				gitTimeoutMs: 123,
			}),
		);

		const cfg = loadTelemetryConfig({
			configPath,
			env: {
				PI_TELEMETRY_ENABLED: "true",
				PI_TELEMETRY_LOG_PATH: "/from-env.jsonl",
				PI_TELEMETRY_TEAM: "infra",
				PI_TELEMETRY_PROJECT: "pi",
				PI_TELEMETRY_DEVELOPER: "env-dev",
				PI_TELEMETRY_GIT: "true",
				PI_TELEMETRY_WARN_ON_ERROR: "true",
			},
		});

		expect(cfg).toMatchObject({
			enabled: true,
			logPath: "/from-env.jsonl",
			team: "infra",
			project: "pi",
			developer: "env-dev",
			collectGit: true,
			warnOnError: true,
			gitTimeoutMs: 123,
		});
	});
});

describe("usage records", () => {
	test("extracts only assistant messages with usage", () => {
		expect(extractAssistantUsage({ role: "user", content: "hi" })).toBeNull();
		expect(extractAssistantUsage({ role: "assistant" })).toBeNull();
		expect(extractAssistantUsage(assistant())).toEqual(assistant().usage);
	});

	test("builds a versioned turn_usage record without content", () => {
		const record = buildTurnUsageRecord({
			event: {
				type: "turn_end",
				turnIndex: 2,
				message: assistant(),
				toolResults: [],
			} satisfies TurnEndEvent,
			ctx: context("/work/acme/widget"),
			config: config({ team: "platform" }),
			git: {
				root: "/work/acme/widget",
				remote: "git@github.com:acme/widget.git",
				branch: "main",
				commit: "abc123",
				userName: "Jane Dev",
				userEmail: "jane@example.com",
			},
		});

		expect(record).toMatchObject({
			schemaVersion: 1,
			type: "turn_usage",
			turn: { index: 2 },
			session: {
				id: "session-1",
				file: "/tmp/session.jsonl",
				cwd: "/work/acme/widget",
				cwdName: "widget",
			},
			model: {
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			},
			labels: {
				team: "platform",
				project: "widget",
				developer: "jane@example.com",
			},
			usage: {
				input: 100,
				output: 25,
				cacheRead: 10,
				cacheWrite: 5,
				totalTokens: 140,
				cost: {
					total: 0.0033,
				},
			},
		});
		expect(JSON.stringify(record)).not.toContain("SECRET RESPONSE");
	});

	test("writes append-only JSONL and creates parent directories", async () => {
		const dir = await tempDir();
		const logPath = join(dir, "nested", "events.jsonl");
		const record = buildTurnUsageRecord({
			event: {
				type: "turn_end",
				turnIndex: 1,
				message: assistant(),
				toolResults: [],
			} satisfies TurnEndEvent,
			ctx: context(dir),
			config: config(),
			git: {},
		});

		if (!record) throw new Error("expected record");
		await writeJsonl(logPath, record);
		await writeJsonl(logPath, record);

		const lines = (await readFile(logPath, "utf8")).trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
			type: "turn_usage",
			schemaVersion: 1,
		});
	});
});

describe("turn handler", () => {
	test("does not write when disabled", async () => {
		let writes = 0;
		const sink: TelemetrySink = {
			async write() {
				writes++;
			},
		};

		await handleTurnEnd({
			event: {
				type: "turn_end",
				turnIndex: 1,
				message: assistant(),
				toolResults: [],
			} satisfies TurnEndEvent,
			ctx: context("/tmp/project"),
			config: config({ enabled: false }),
			sink,
			collectGit: async () => ({}),
			warn: () => {},
		});

		expect(writes).toBe(0);
	});

	test("never throws when git collection or writing fails", async () => {
		const warnings: string[] = [];
		const sink: TelemetrySink = {
			async write() {
				throw new Error("disk full");
			},
		};

		await expect(
			handleTurnEnd({
				event: {
					type: "turn_end",
					turnIndex: 1,
					message: assistant(),
					toolResults: [],
				} satisfies TurnEndEvent,
				ctx: context("/tmp/project"),
				config: config(),
				sink,
				collectGit: async () => {
					throw new Error("not a git repo");
				},
				warn: (message) => warnings.push(message),
			}),
		).resolves.toBeUndefined();
		expect(warnings.join("\n")).toContain("Telemetry");
	});
});
