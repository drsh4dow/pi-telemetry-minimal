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
	DEFAULT_WEBHOOK_TIMEOUT_MS,
	extractAssistantUsage,
	handleTurnEnd,
	loadTelemetryConfig,
	type TelemetryConfig,
	type TelemetrySink,
	WebhookTelemetrySink,
	writeJsonl,
} from "./extensions/telemetry-minimal.ts";

const tempDirs: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
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

function turnEvent(overrides: Partial<TurnEndEvent> = {}): TurnEndEvent {
	return {
		type: "turn_end",
		turnIndex: 1,
		message: assistant(),
		toolResults: [],
		...overrides,
	};
}

function context(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => "/tmp/session.jsonl",
		},
	} as unknown as ExtensionContext;
}

function config(overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
	return {
		enabled: true,
		labels: {},
		sinks: {
			local: { path: DEFAULT_LOG_PATH },
		},
		git: { enabled: true, timeoutMs: 750 },
		warnOnError: true,
		warnings: [],
		...overrides,
	};
}

function record() {
	const built = buildTurnUsageRecord({
		event: turnEvent(),
		ctx: context("/work/acme/widget"),
		config: config(),
		git: {},
	});
	if (!built) throw new Error("expected record");
	return built;
}

function startWebhookServer(
	handler: (request: Request) => Response | Promise<Response>,
) {
	const server = Bun.serve({
		port: 0,
		fetch: handler,
	});
	servers.push(server);
	return `http://127.0.0.1:${server.port}/telemetry`;
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
		expect(cfg.sinks.local.path).toBe(DEFAULT_LOG_PATH);
		expect(cfg.sinks.webhook).toBeUndefined();
		expect(cfg.git.enabled).toBe(true);
		expect(cfg.git.timeoutMs).toBe(750);
		expect(cfg.warnOnError).toBe(true);
		expect(cfg.warnings).toEqual([]);
	});

	test("uses nested config file with env overrides", async () => {
		const dir = await tempDir();
		const configPath = join(dir, "config.json");
		await Bun.write(
			configPath,
			JSON.stringify({
				enabled: false,
				labels: {
					team: "platform",
					project: "agent",
					developer: "config-dev",
				},
				sinks: {
					local: { path: "/from-config.jsonl" },
					webhook: {
						url: "https://example.com/config-hook",
						token: "config-token",
						timeoutMs: 123,
					},
				},
				git: { enabled: false, timeoutMs: 456 },
				warnOnError: false,
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
				PI_TELEMETRY_GIT_TIMEOUT_MS: "789",
				PI_TELEMETRY_WARN_ON_ERROR: "true",
				PI_TELEMETRY_WEBHOOK_URL: "http://localhost/env-hook",
				PI_TELEMETRY_WEBHOOK_TOKEN: "env-token",
				PI_TELEMETRY_WEBHOOK_TIMEOUT_MS: "234",
			},
		});

		expect(cfg).toMatchObject({
			enabled: true,
			labels: {
				team: "infra",
				project: "pi",
				developer: "env-dev",
			},
			sinks: {
				local: { path: "/from-env.jsonl" },
				webhook: {
					url: "http://localhost/env-hook",
					token: "env-token",
					timeoutMs: 234,
				},
			},
			git: { enabled: true, timeoutMs: 789 },
			warnOnError: true,
			warnings: [],
		});
	});

	test("breaks old flat file config while preserving env compatibility", async () => {
		const dir = await tempDir();
		const configPath = join(dir, "config.json");
		await Bun.write(
			configPath,
			JSON.stringify({
				logPath: "/old-file.jsonl",
				team: "old-team",
				project: "old-project",
				developer: "old-dev",
				collectGit: false,
				gitTimeoutMs: 123,
			}),
		);

		const cfg = loadTelemetryConfig({
			configPath,
			env: {
				PI_TELEMETRY_LOG_PATH: "/from-env.jsonl",
				PI_TELEMETRY_TEAM: "env-team",
				PI_TELEMETRY_GIT: "false",
			},
		});

		expect(cfg.sinks.local.path).toBe("/from-env.jsonl");
		expect(cfg.labels).toEqual({ team: "env-team" });
		expect(cfg.git.enabled).toBe(false);
		expect(cfg.git.timeoutMs).toBe(750);
	});

	test("skips invalid webhook config with warnings", async () => {
		const dir = await tempDir();
		const configPath = join(dir, "config.json");
		await Bun.write(
			configPath,
			JSON.stringify({
				sinks: {
					webhook: { url: "file:///tmp/events", timeoutMs: 100 },
				},
			}),
		);

		const invalidUrl = loadTelemetryConfig({ configPath, env: {} });
		expect(invalidUrl.sinks.webhook).toBeUndefined();
		expect(invalidUrl.warnings.join("\n")).toContain("webhook URL");

		const invalidTimeout = loadTelemetryConfig({
			configPath: "/tmp/does-not-exist-pi-telemetry-minimal.json",
			env: {
				PI_TELEMETRY_WEBHOOK_URL: "https://example.com/hook",
				PI_TELEMETRY_WEBHOOK_TIMEOUT_MS: "nope",
			},
		});
		expect(invalidTimeout.sinks.webhook).toBeUndefined();
		expect(invalidTimeout.warnings.join("\n")).toContain("webhook timeout");
	});

	test("defaults webhook timeout when url is configured", () => {
		const cfg = loadTelemetryConfig({
			configPath: "/tmp/does-not-exist-pi-telemetry-minimal.json",
			env: { PI_TELEMETRY_WEBHOOK_URL: "https://example.com/hook" },
		});

		expect(cfg.sinks.webhook).toMatchObject({
			url: "https://example.com/hook",
			timeoutMs: DEFAULT_WEBHOOK_TIMEOUT_MS,
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
			event: turnEvent({ turnIndex: 2 }),
			ctx: context("/work/acme/widget"),
			config: config({ labels: { team: "platform" } }),
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
			event: turnEvent(),
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

describe("webhook sink", () => {
	test("posts the exact record with JSON, bearer auth, and user agent", async () => {
		let seen: { body: unknown; headers: Headers } | undefined;
		const url = startWebhookServer(async (request) => {
			seen = {
				body: await request.json(),
				headers: request.headers,
			};
			return new Response(null, { status: 202 });
		});
		const usageRecord = record();

		await new WebhookTelemetrySink({
			url,
			token: "secret-token",
			timeoutMs: 1000,
		}).write(usageRecord);

		expect(seen?.body).toEqual(usageRecord);
		expect(seen?.headers.get("authorization")).toBe("Bearer secret-token");
		expect(seen?.headers.get("content-type")).toContain("application/json");
		expect(seen?.headers.get("user-agent")).toContain("pi-telemetry-minimal");
	});

	test("does not require a webhook token", async () => {
		let authorization: string | null = "not-called";
		const url = startWebhookServer((request) => {
			authorization = request.headers.get("authorization");
			return new Response(null, { status: 204 });
		});

		await new WebhookTelemetrySink({ url, timeoutMs: 1000 }).write(record());

		expect(authorization).toBeNull();
	});

	test("treats non-2xx responses as failures without reading the body", async () => {
		const url = startWebhookServer(
			() => new Response("backend secret", { status: 500 }),
		);

		await expect(
			new WebhookTelemetrySink({ url, timeoutMs: 1000 }).write(record()),
		).rejects.toThrow("HTTP 500");
	});

	test("times out slow webhook requests", async () => {
		const url = startWebhookServer(
			() => new Promise<Response>(() => undefined),
		);

		await expect(
			new WebhookTelemetrySink({ url, timeoutMs: 1 }).write(record()),
		).rejects.toThrow("timed out");
	});
});

describe("turn handler", () => {
	test("does not write when disabled", async () => {
		let writes = 0;
		const sink: TelemetrySink = {
			name: "test",
			async write() {
				writes++;
			},
		};

		await handleTurnEnd({
			event: turnEvent(),
			ctx: context("/tmp/project"),
			config: config({ enabled: false }),
			sinks: [sink],
			collectGit: async () => ({}),
			warn: () => {},
		});

		expect(writes).toBe(0);
	});

	test("never throws when git collection or writing fails", async () => {
		const warnings: string[] = [];
		const sink: TelemetrySink = {
			name: "local",
			async write() {
				throw new Error("disk full");
			},
		};

		await expect(
			handleTurnEnd({
				event: turnEvent(),
				ctx: context("/tmp/project"),
				config: config(),
				sinks: [sink],
				collectGit: async () => {
					throw new Error("not a git repo");
				},
				warn: (message) => warnings.push(message),
			}),
		).resolves.toBeUndefined();
		expect(warnings.join("\n")).toContain("Telemetry");
		expect(warnings.join("\n")).toContain("local");
	});

	test("attempts each sink independently", async () => {
		const writes: string[] = [];
		const warnings: string[] = [];
		const failing: TelemetrySink = {
			name: "webhook",
			async write() {
				writes.push("webhook");
				throw new Error("HTTP 500");
			},
		};
		const succeeding: TelemetrySink = {
			name: "local",
			async write() {
				writes.push("local");
			},
		};

		await handleTurnEnd({
			event: turnEvent(),
			ctx: context("/tmp/project"),
			config: config({ git: { enabled: false, timeoutMs: 750 } }),
			sinks: [failing, succeeding],
			collectGit: async () => {
				throw new Error("should not collect git");
			},
			warn: (message) => warnings.push(message),
		});

		expect(writes.sort()).toEqual(["local", "webhook"]);
		expect(warnings.join("\n")).toContain("webhook");
		expect(warnings.join("\n")).toContain("HTTP 500");
	});
});
