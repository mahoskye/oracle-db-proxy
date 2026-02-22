import { z } from "zod";
import { readFileSync } from "fs";
import yaml from "js-yaml";
import { CONFIG_PATH } from "./paths";

/** Zod schema for database credentials (username + env var name for password). */
const CredentialSchema = z.object({
	username: z.string().min(1, "credentials.username must not be empty"),
	password_env: z.string().min(1, "credentials.password_env must not be empty"),
}).strict();

const EnvironmentSchema = z.object({
	hostname: z.string().min(1, "hostname must not be empty"),
	port: z.number().int().min(1).max(65535).default(1521),
	service: z.string().min(1, "service must not be empty"),
	allowlist_enabled: z.boolean().default(false),
	allowed_tables: z.array(z.string().min(1)).optional(),
	timeout_seconds: z.number().int().positive().optional(),
	max_rows: z.number().int().positive().optional(),
	credentials: CredentialSchema.optional(), // overrides top-level credentials
}).strict();

const ConfigSchema = z.object({
	credentials: CredentialSchema,
	defaults: z.object({
		timeout_seconds: z.number().int().positive().default(30),
		max_rows: z.number().int().positive().default(1000),
	}).strict(),
	environments: z.record(z.string(), EnvironmentSchema),
}).strict();

/** Database credentials: username and the name of the env var holding the password. */
export type Credentials = z.infer<typeof CredentialSchema>;
/** Raw environment configuration as parsed from YAML (before defaults are applied). */
export type Environment = z.infer<typeof EnvironmentSchema>;
/** Top-level configuration: credentials, defaults, and named environments. */
export type Config = z.infer<typeof ConfigSchema>;

/** Fully resolved environment with defaults applied and password read from env var. */
export type ResolvedEnvironment = {
  hostname: string;
  port: number;
  service: string;
  allowlist_enabled: boolean;
  allowed_tables: string[];
  timeout_seconds: number;
  max_rows: number;
  username: string;
  password: string; // resolved form env var, not the var name
};

/** Parses and validates an unknown raw config payload into a typed Config object. */
export function parseConfig(raw: unknown): Config {
	const results = ConfigSchema.safeParse(raw);
	if (!results.success) {
		throw new Error(`Invalid config: ${results.error.message}`);
	}
	return results.data;
}

/**
 * Loads and validates `config.yaml` from the config directory.
 * Called fresh on every tool invocation (no caching) so config edits take effect immediately.
 * @throws If the file cannot be read or fails Zod validation.
 */
export function loadConfig(): Config {
	let raw: unknown;
	try {
		const file = readFileSync(CONFIG_PATH, "utf8");
		raw = yaml.load(file);
	}
	catch (e) {
		throw new Error(`Could not read config file at ${CONFIG_PATH}: ${e}`);
	}

	return parseConfig(raw);
}

/**
 * Merges an environment's settings with top-level defaults and resolves the password
 * from the environment variable specified by `password_env`.
 * @throws If the environment name is unknown or the password env var is not set.
 */
export function resolveEnvironment(config: Config, name: string): ResolvedEnvironment {
	const env = config.environments[name];
	if (!env) {
		throw new Error(`Unknown environment "${name}". Available: ${Object.keys(config.environments).join(", ")}`);
	}

	const creds = env.credentials ?? config.credentials;
	const password = process.env[creds.password_env];
	if (!password) {
		throw new Error(`Environment variable "${creds.password_env}" is not set. This is required for environment "${name}".`);
	}

	return {
		hostname: env.hostname,
		port: env.port,
		service: env.service,
		allowlist_enabled: env.allowlist_enabled,
		allowed_tables: env.allowed_tables ?? [],
		timeout_seconds: env.timeout_seconds ?? config.defaults.timeout_seconds,
		max_rows: env.max_rows ?? config.defaults.max_rows,
		username: creds.username,
		password,
	};
}
