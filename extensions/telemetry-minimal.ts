import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AssistantMessage, Usage } from "@mariozechner/pi-ai";
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

const DEFAULT_GIT_TIMEOUT_MS = 750;

export interface TelemetryConfig {
	enabled: boolean;
	logPath: string;
	team?: string;
	project?: string;
	developer?: string;
	collectGit: boolean;
	warnOnError: boolean;
	gitTimeoutMs: number;
}

interface RawTelemetryConfig {
	enabled?: unknown;
	logPath?: unknown;
	team?: unknown;
	project?: unknown;
	developer?: unknown;
	collectGit?: unknown;
	warnOnError?: unknown;
	gitTimeoutMs?: unknown;
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
	turn: { index: number };
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
	write(record: TurnUsageRecord): Promise<void>;
}

export class JsonlTelemetrySink implements TelemetrySink {
	constructor(private readonly logPath: string) {}

	async write(record: TurnUsageRecord): Promise<void> {
		await writeJsonl(this.logPath, record);
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

export function loadTelemetryConfig(options?: {
	env?: Env;
	configPath?: string;
}): TelemetryConfig {
	const env = options?.env ?? (process.env as Env);
	const raw = readConfigFile(options?.configPath ?? CONFIG_PATH);

	return {
		enabled:
			parseBoolean(env.PI_TELEMETRY_ENABLED) ??
			parseBoolean(raw.enabled) ??
			true,
		logPath: expandHome(
			cleanString(env.PI_TELEMETRY_LOG_PATH) ??
				cleanString(raw.logPath) ??
				DEFAULT_LOG_PATH,
		),
		team: cleanString(env.PI_TELEMETRY_TEAM) ?? cleanString(raw.team),
		project: cleanString(env.PI_TELEMETRY_PROJECT) ?? cleanString(raw.project),
		developer:
			cleanString(env.PI_TELEMETRY_DEVELOPER) ?? cleanString(raw.developer),
		collectGit:
			parseBoolean(env.PI_TELEMETRY_GIT) ??
			parseBoolean(raw.collectGit) ??
			true,
		warnOnError:
			parseBoolean(env.PI_TELEMETRY_WARN_ON_ERROR) ??
			parseBoolean(raw.warnOnError) ??
			true,
		gitTimeoutMs:
			parsePositiveNumber(env.PI_TELEMETRY_GIT_TIMEOUT_MS) ??
			parsePositiveNumber(raw.gitTimeoutMs) ??
			DEFAULT_GIT_TIMEOUT_MS,
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

function assistantMessage(message: unknown): AssistantMessage | null {
	if (!message || typeof message !== "object") return null;
	const maybe = message as Partial<AssistantMessage>;
	if (maybe.role !== "assistant" || !isUsage(maybe.usage)) return null;
	if (
		typeof maybe.api !== "string" ||
		typeof maybe.provider !== "string" ||
		typeof maybe.model !== "string"
	) {
		return null;
	}
	return maybe as AssistantMessage;
}

function projectFrom(cwd: string, git: GitMetadata, config: TelemetryConfig) {
	return config.project ?? (git.root ? basename(git.root) : basename(cwd));
}

function developerFrom(git: GitMetadata, config: TelemetryConfig) {
	return config.developer ?? git.userEmail ?? git.userName;
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
		turn: { index: input.event.turnIndex },
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
			team: input.config.team,
			project: projectFrom(input.ctx.cwd, input.git, input.config),
			developer: developerFrom(input.git, input.config),
		},
		git: input.config.collectGit ? input.git : undefined,
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
): Promise<void> {
	await mkdir(dirname(logPath), { recursive: true });
	await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
}

async function gitValue(
	cwd: string,
	args: string[],
	timeoutMs: number,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: timeoutMs, windowsHide: true },
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
): Promise<GitMetadata> {
	const [root, remote, branch, commit, userName, userEmail] = await Promise.all(
		[
			gitValue(cwd, ["rev-parse", "--show-toplevel"], timeoutMs),
			gitValue(cwd, ["remote", "get-url", "origin"], timeoutMs),
			gitValue(cwd, ["branch", "--show-current"], timeoutMs),
			gitValue(cwd, ["rev-parse", "HEAD"], timeoutMs),
			gitValue(cwd, ["config", "user.name"], timeoutMs),
			gitValue(cwd, ["config", "user.email"], timeoutMs),
		],
	);

	return { root, remote, branch, commit, userName, userEmail };
}

export async function handleTurnEnd(input: {
	event: TurnEndEvent;
	ctx: ExtensionContext;
	config: TelemetryConfig;
	sink: TelemetrySink;
	collectGit: (cwd: string, timeoutMs: number) => Promise<GitMetadata>;
	warn: WarningSink;
}): Promise<void> {
	if (!input.config.enabled) return;

	let git: GitMetadata = {};
	if (input.config.collectGit) {
		try {
			git = await input.collectGit(input.ctx.cwd, input.config.gitTimeoutMs);
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

	try {
		await input.sink.write(record);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		input.warn(`Telemetry write failed: ${message}`, input.ctx);
	}
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
		await handleTurnEnd({
			event,
			ctx,
			config,
			sink: new JsonlTelemetrySink(config.logPath),
			collectGit: collectGitMetadata,
			warn,
		});
	});
}
