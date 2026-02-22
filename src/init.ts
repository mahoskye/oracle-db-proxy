import { existsSync, mkdirSync, writeFileSync } from "fs";
import Database from "bun:sqlite";
import { loadConfig } from "./config";
import type { Config } from "./config";
import { CONFIG_DIR, CONFIG_PATH, AUDIT_DB_PATH } from "./paths";

// Establish the config template
const CONFIG_TEMPLATE = `# oracle-db-proxy configuration
# Edit this file before starting the server.
# Passwords must be set as environment variables, not in this file.

credentials:
  username: CHANGE_ME
  password_env: ORACLE_DB_PASSWORD
# Passwords are read from environment variables only.
# Set the variable name here, then set the actual password
# in your shell or in your MCP client's env block.
# Example: password_env: ORACLE_DB_PASSWORD
#          then set ORACLE_DB_PASSWORD=yourpassword in your environment

defaults:
  timeout_seconds: 30
  max_rows: 1000

environments:
  dev:
    hostname: CHANGE_ME
    port: 1521
    service: CHANGE_ME
    allowlist_enabled: false

  test:
    hostname: CHANGE_ME
    port: 1521
    service: CHANGE_ME
    allowlist_enabled: false

  prod:
    hostname: CHANGE_ME
    port: 1521
    service: CHANGE_ME
    allowlist_enabled: true
    allowed_tables: []
`;

// Establish the audit.db schema
const AUDIT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS query_log (
	id	 				INTEGER PRIMARY KEY AUTOINCREMENT,
	timestamp	 		TEXT NOT NULL,
	environment			TEXT NOT NULL,
	status				TEXT NOT NULL,
	sql_hash			TEXT NOT NULL,
	sql_text			TEXT NOT NULL,
	rejection_reason	TEXT,
	row_count			INTEGER,
	execution_ms		INTEGER,
	truncated			INTEGER NOT NULL DEFAULT 0
  );
`;

/**
 * Ensures the audit database file exists and the query_log table schema is present.
 * @returns true when the database file did not exist before this call.
 */
export function ensureAuditSchema(auditDbPath: string): boolean {
	const auditDbExisted = existsSync(auditDbPath);
	const db = new Database(auditDbPath);
	db.exec(AUDIT_SCHEMA);
	db.close();
	return !auditDbExisted;
}

/** Throws when required placeholder values are still present in config.yaml. */
export function validateConfigPlaceholders(config: Config): void {
	for (const [name, env] of Object.entries(config.environments)) {
		if (env.hostname === "CHANGE_ME" || env.service === "CHANGE_ME") {
			throw new Error(
				`Environment "${name}" still has placeholder values. `
				+ `Please edit ${CONFIG_PATH} before running.`
			);
		}

		if (env.credentials?.username === "CHANGE_ME") {
			throw new Error(
				`Environment "${name}" credentials still have placeholder values. `
				+ `Please edit ${CONFIG_PATH} before running.`
			);
		}
	}

	if (config.credentials.username === "CHANGE_ME") {
		throw new Error(
			`Credentials still have placeholder values. `
			+ `Please edit ${CONFIG_PATH} before running.`
		);
	}
}

/**
 * First-run initialisation routine. Creates the config directory, writes a
 * template `config.yaml` if absent, initialises the audit SQLite database,
 * and validates that all placeholder values have been replaced.
 * Exits the process if the config was just created (user must fill it in first).
 */
export function runInit(): void {
	// Create config directory if it doesn't exist
	if(!existsSync(CONFIG_DIR)){
		mkdirSync(CONFIG_DIR, {recursive:true});
		console.error(`Created config directory at ${CONFIG_DIR}`);
	}

	// Write template config if none exists
	let createdTemplateConfig = false;
	if(!existsSync(CONFIG_PATH)){
		writeFileSync(CONFIG_PATH, CONFIG_TEMPLATE, "utf8");
		console.error(`Created template config at ${CONFIG_PATH}`);
		createdTemplateConfig = true;
	}

	// Ensure audit database file and schema both exist
	const createdAuditDb = ensureAuditSchema(AUDIT_DB_PATH);
	if(createdAuditDb){
		console.error(`Created audit database at ${AUDIT_DB_PATH}`);
	}

	// If config was just created, stop after all first-run files are initialized.
	if(createdTemplateConfig){
		console.error(`Please fill in your database connection details before running again.`);
		process.exit(0);
	}

	// Load and validate config, check for placeholder values
	const config = loadConfig();
	validateConfigPlaceholders(config);

	// Warn about empty allowlists
	for(const [name, env] of Object.entries(config.environments)){
		if(env.allowlist_enabled && (!env.allowed_tables || env.allowed_tables.length === 0)){
			console.error(`Warning: Environment "${name}" has allowlist_enabled but no allowed_tables defined. All queries will be rejected.`);
		}
	}

}
