import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AssistantMessage, StopReason, Usage } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	TurnEndEvent,
} from "@mariozechner/pi-coding-agent";

export const CONFIG_PATH = join(homedir(), ".pi", "telemetry-minimal.json");
export const DEFAULT_LOG_PATH = join(
	homedir(),
	".pi",
	"telemetry-minimal",
	"events.jsonl",
);
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 2000;

const DEFAULT_GIT_TIMEOUT_MS = 750;
const WEBHOOK_USER_AGENT = "pi-telemetry-minimal/0.2.2";

export interface TelemetryConfig {
	enabled: boolean;
	labels: {
		team?: string;
		project?: string;
		developer?: string;
	};
	sinks: {
		local: { path: string };
		webhook?: {
			url: string;
			token?: string;
			timeoutMs: number;
		};
	};
	git: {
		enabled: boolean;
		timeoutMs: number;
	};
	warnOnError: boolean;
	warnings: string[];
}

interface RawTelemetryConfig {
	enabled?: unknown;
	labels?: unknown;
	sinks?: unknown;
	git?: unknown;
	warnOnError?: unknown;
}

interface RawLabelsConfig {
	team?: unknown;
	project?: unknown;
	developer?: unknown;
}

interface RawSinksConfig {
	local?: unknown;
	webhook?: unknown;
}

interface RawLocalConfig {
	path?: unknown;
}

interface RawWebhookConfig {
	url?: unknown;
	token?: unknown;
	timeoutMs?: unknown;
}

interface RawGitConfig {
	enabled?: unknown;
	timeoutMs?: unknown;
}

export interface GitMetadata {
	root?: string;
	remote?: string;
	branch?: string;
	commit?: string;
	userName?: string;
	userEmail?: string;
}

export interface TurnUsageRecord {
	schemaVersion: 1;
	type: "turn_usage";
	timestamp: string;
	turn: { index: number; stopReason: StopReason };
	session: {
		id: string;
		file?: string;
		cwd: string;
		cwdName: string;
	};
	model: {
		api: string;
		provider: string;
		model: string;
	};
	labels: {
		team?: string;
		project?: string;
		developer?: string;
	};
	git?: GitMetadata;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: Usage["cost"];
	};
}

export interface TelemetrySink {
	name: string;
	write(record: TurnUsageRecord, signal?: AbortSignal): Promise<void>;
}

export class JsonlTelemetrySink implements TelemetrySink {
	readonly name = "local";

	constructor(private readonly logPath: string) {}

	async write(record: TurnUsageRecord, signal?: AbortSignal): Promise<void> {
		await writeJsonl(this.logPath, record, signal);
	}
}

export class WebhookTelemetrySink implements TelemetrySink {
	readonly name = "webhook";

	constructor(
		private readonly options: {
			url: string;
			token?: string;
			timeoutMs: number;
			fetch?: typeof fetch;
		},
	) {}

	async write(record: TurnUsageRecord, signal?: AbortSignal): Promise<void> {
		const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
		const requestSignal = signal
			? AbortSignal.any([signal, timeoutSignal])
			: timeoutSignal;
		const headers: {
			"Content-Type": string;
			"User-Agent": string;
			Authorization?: string;
		} = {
			"Content-Type": "application/json",
			"User-Agent": WEBHOOK_USER_AGENT,
		};
		if (this.options.token) {
			headers.Authorization = `Bearer ${this.options.token}`;
		}

		let response: Response;
		try {
			response = await (this.options.fetch ?? fetch)(this.options.url, {
				method: "POST",
				headers,
				body: JSON.stringify(record),
				signal: requestSignal,
			});
		} catch (error) {
			if (timeoutSignal.aborted) {
				throw new Error(`request timed out after ${this.options.timeoutMs}ms`);
			}
			if (signal?.aborted) {
				throw new Error("request aborted");
			}
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(message);
		}

		if (response.status < 200 || response.status > 299) {
			throw new Error(`HTTP ${response.status}`);
		}
	}
}

interface Env {
	PI_TELEMETRY_ENABLED?: string;
	PI_TELEMETRY_LOG_PATH?: string;
	PI_TELEMETRY_TEAM?: string;
	PI_TELEMETRY_PROJECT?: string;
	PI_TELEMETRY_DEVELOPER?: string;
	PI_TELEMETRY_GIT?: string;
	PI_TELEMETRY_WARN_ON_ERROR?: string;
	PI_TELEMETRY_GIT_TIMEOUT_MS?: string;
	PI_TELEMETRY_WEBHOOK_URL?: string;
	PI_TELEMETRY_WEBHOOK_TOKEN?: string;
	PI_TELEMETRY_WEBHOOK_TIMEOUT_MS?: string;
}

type WarningSink = (message: string, ctx: ExtensionContext) => void;

function cleanString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function recordObject<T extends object>(value: unknown): T {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return {} as T;
	return value as T;
}

function parseBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function parsePositiveNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	if (typeof value !== "string") return undefined;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function readConfigFile(configPath: string): RawTelemetryConfig {
	if (!existsSync(configPath)) return {};
	try {
		return JSON.parse(readFileSync(configPath, "utf8")) as RawTelemetryConfig;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse ${configPath}: ${message}`);
	}
}

function parseWebhookUrl(value: unknown): string | undefined {
	const cleaned = cleanString(value);
	if (!cleaned) return undefined;
	try {
		const url = new URL(cleaned);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

export function loadTelemetryConfig(options?: {
	env?: Env;
	configPath?: string;
}): TelemetryConfig {
	const env = options?.env ?? (process.env as Env);
	const raw = readConfigFile(options?.configPath ?? CONFIG_PATH);
	const rawLabels = recordObject<RawLabelsConfig>(raw.labels);
	const rawSinks = recordObject<RawSinksConfig>(raw.sinks);
	const rawLocal = recordObject<RawLocalConfig>(rawSinks.local);
	const rawWebhook = recordObject<RawWebhookConfig>(rawSinks.webhook);
	const rawGit = recordObject<RawGitConfig>(raw.git);
	const warnings: string[] = [];

	const webhookUrlRaw = env.PI_TELEMETRY_WEBHOOK_URL ?? rawWebhook.url;
	const webhookUrl = parseWebhookUrl(webhookUrlRaw);
	const webhookToken =
		cleanString(env.PI_TELEMETRY_WEBHOOK_TOKEN) ??
		cleanString(rawWebhook.token);
	const webhookTimeoutRaw =
		env.PI_TELEMETRY_WEBHOOK_TIMEOUT_MS ?? rawWebhook.timeoutMs;
	const webhookTimeout = parsePositiveNumber(webhookTimeoutRaw);
	let webhook: TelemetryConfig["sinks"]["webhook"];

	if (cleanString(webhookUrlRaw)) {
		if (!webhookUrl) {
			warnings.push(
				"Telemetry webhook URL must use http or https; skipping webhook sink",
			);
		} else if (
			webhookTimeoutRaw !== undefined &&
			webhookTimeout === undefined
		) {
			warnings.push(
				"Telemetry webhook timeout must be a positive number; skipping webhook sink",
			);
		} else {
			webhook = {
				url: webhookUrl,
				token: webhookToken,
				timeoutMs: webhookTimeout ?? DEFAULT_WEBHOOK_TIMEOUT_MS,
			};
		}
	}

	return {
		enabled:
			parseBoolean(env.PI_TELEMETRY_ENABLED) ??
			parseBoolean(raw.enabled) ??
			true,
		labels: {
			team: cleanString(env.PI_TELEMETRY_TEAM) ?? cleanString(rawLabels.team),
			project:
				cleanString(env.PI_TELEMETRY_PROJECT) ?? cleanString(rawLabels.project),
			developer:
				cleanString(env.PI_TELEMETRY_DEVELOPER) ??
				cleanString(rawLabels.developer),
		},
		sinks: {
			local: {
				path: expandHome(
					cleanString(env.PI_TELEMETRY_LOG_PATH) ??
						cleanString(rawLocal.path) ??
						DEFAULT_LOG_PATH,
				),
			},
			webhook,
		},
		git: {
			enabled:
				parseBoolean(env.PI_TELEMETRY_GIT) ??
				parseBoolean(rawGit.enabled) ??
				true,
			timeoutMs:
				parsePositiveNumber(env.PI_TELEMETRY_GIT_TIMEOUT_MS) ??
				parsePositiveNumber(rawGit.timeoutMs) ??
				DEFAULT_GIT_TIMEOUT_MS,
		},
		warnOnError:
			parseBoolean(env.PI_TELEMETRY_WARN_ON_ERROR) ??
			parseBoolean(raw.warnOnError) ??
			true,
		warnings,
	};
}

function isUsage(value: unknown): value is Usage {
	if (!value || typeof value !== "object") return false;
	const usage = value as Partial<Usage>;
	return (
		typeof usage.input === "number" &&
		typeof usage.output === "number" &&
		typeof usage.cacheRead === "number" &&
		typeof usage.cacheWrite === "number" &&
		typeof usage.totalTokens === "number" &&
		!!usage.cost &&
		typeof usage.cost.total === "number"
	);
}

export function extractAssistantUsage(message: unknown): Usage | null {
	if (!message || typeof message !== "object") return null;
	const maybe = message as Partial<AssistantMessage>;
	if (maybe.role !== "assistant" || !isUsage(maybe.usage)) return null;
	return maybe.usage;
}

function isStopReason(value: unknown): value is StopReason {
	return (
		value === "stop" ||
		value === "length" ||
		value === "toolUse" ||
		value === "error" ||
		value === "aborted"
	);
}

function assistantMessage(message: unknown): AssistantMessage | null {
	if (!message || typeof message !== "object") return null;
	const maybe = message as Partial<AssistantMessage>;
	if (maybe.role !== "assistant" || !isUsage(maybe.usage)) return null;
	if (
		typeof maybe.api !== "string" ||
		typeof maybe.provider !== "string" ||
		typeof maybe.model !== "string" ||
		!isStopReason(maybe.stopReason)
	) {
		return null;
	}
	return maybe as AssistantMessage;
}

function projectFrom(cwd: string, git: GitMetadata, config: TelemetryConfig) {
	return (
		config.labels.project ?? (git.root ? basename(git.root) : basename(cwd))
	);
}

function developerFrom(git: GitMetadata, config: TelemetryConfig) {
	return config.labels.developer ?? git.userEmail ?? git.userName;
}

export function buildTurnUsageRecord(input: {
	event: TurnEndEvent;
	ctx: ExtensionContext;
	config: TelemetryConfig;
	git: GitMetadata;
}): TurnUsageRecord | null {
	const message = assistantMessage(input.event.message);
	if (!message) return null;

	return {
		schemaVersion: 1,
		type: "turn_usage",
		timestamp: new Date().toISOString(),
		turn: {
			index: input.event.turnIndex,
			stopReason: message.stopReason,
		},
		session: {
			id: input.ctx.sessionManager.getSessionId(),
			file: input.ctx.sessionManager.getSessionFile(),
			cwd: input.ctx.cwd,
			cwdName: basename(input.ctx.cwd),
		},
		model: {
			api: message.api,
			provider: message.provider,
			model: message.model,
		},
		labels: {
			team: input.config.labels.team,
			project: projectFrom(input.ctx.cwd, input.git, input.config),
			developer: developerFrom(input.git, input.config),
		},
		git: input.config.git.enabled ? input.git : undefined,
		usage: {
			input: message.usage.input,
			output: message.usage.output,
			cacheRead: message.usage.cacheRead,
			cacheWrite: message.usage.cacheWrite,
			totalTokens: message.usage.totalTokens,
			cost: message.usage.cost,
		},
	};
}

export async function writeJsonl(
	logPath: string,
	record: TurnUsageRecord,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	await mkdir(dirname(logPath), { recursive: true });
	signal?.throwIfAborted();
	await appendFile(logPath, `${JSON.stringify(record)}\n`, {
		encoding: "utf8",
		signal,
	} as Parameters<typeof appendFile>[2]);
}

async function gitValue(
	cwd: string,
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			"git",
			args,
			{ cwd, signal, timeout: timeoutMs, windowsHide: true },
			(error, stdout) => {
				if (error) {
					resolve(undefined);
					return;
				}
				resolve(cleanString(stdout));
			},
		);
	});
}

export async function collectGitMetadata(
	cwd: string,
	timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<GitMetadata> {
	const [root, remote, branch, commit, userName, userEmail] = await Promise.all(
		[
			gitValue(cwd, ["rev-parse", "--show-toplevel"], timeoutMs, signal),
			gitValue(cwd, ["remote", "get-url", "origin"], timeoutMs, signal),
			gitValue(cwd, ["branch", "--show-current"], timeoutMs, signal),
			gitValue(cwd, ["rev-parse", "HEAD"], timeoutMs, signal),
			gitValue(cwd, ["config", "user.name"], timeoutMs, signal),
			gitValue(cwd, ["config", "user.email"], timeoutMs, signal),
		],
	);

	return { root, remote, branch, commit, userName, userEmail };
}

export function createTelemetrySinks(config: TelemetryConfig): TelemetrySink[] {
	const sinks: TelemetrySink[] = [
		new JsonlTelemetrySink(config.sinks.local.path),
	];
	if (config.sinks.webhook) {
		sinks.push(new WebhookTelemetrySink(config.sinks.webhook));
	}
	return sinks;
}

export async function handleTurnEnd(input: {
	event: TurnEndEvent;
	ctx: ExtensionContext;
	config: TelemetryConfig;
	signal?: AbortSignal;
	sinks: TelemetrySink[];
	collectGit: (
		cwd: string,
		timeoutMs: number,
		signal?: AbortSignal,
	) => Promise<GitMetadata>;
	warn: WarningSink;
}): Promise<void> {
	if (!input.config.enabled) return;

	const signal = input.signal?.aborted ? undefined : input.signal;
	let git: GitMetadata = {};
	if (input.config.git.enabled) {
		try {
			git = await input.collectGit(
				input.ctx.cwd,
				input.config.git.timeoutMs,
				signal,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			input.warn(`Telemetry git metadata failed: ${message}`, input.ctx);
		}
	}

	const record = buildTurnUsageRecord({
		event: input.event,
		ctx: input.ctx,
		config: input.config,
		git,
	});
	if (!record) return;

	await Promise.all(
		input.sinks.map(async (sink) => {
			try {
				await sink.write(record, signal);
			} catch (error) {
				if (signal?.aborted || sink.name === "webhook") return;
				const message = error instanceof Error ? error.message : String(error);
				input.warn(
					`Telemetry ${sink.name} write failed: ${message}`,
					input.ctx,
				);
			}
		}),
	);
}

let warningShown = false;

function warnOnce(message: string, ctx: ExtensionContext): void {
	if (warningShown) return;
	warningShown = true;
	try {
		if (ctx.hasUI) {
			ctx.ui.notify(message, "warning");
			return;
		}
	} catch {
		// Fall through to stderr.
	}
	console.warn(message);
}

export default function telemetryMinimalExtension(pi: ExtensionAPI) {
	pi.on("turn_end", async (event, ctx) => {
		let config: TelemetryConfig;
		try {
			config = loadTelemetryConfig();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			warnOnce(`Telemetry config failed: ${message}`, ctx);
			return;
		}
		const warn = config.warnOnError ? warnOnce : () => {};
		for (const warning of config.warnings) {
			warn(warning, ctx);
		}
		await handleTurnEnd({
			event,
			ctx,
			config,
			signal: ctx.signal,
			sinks: createTelemetrySinks(config),
			collectGit: collectGitMetadata,
			warn,
		});
	});
}
