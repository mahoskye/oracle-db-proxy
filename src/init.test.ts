import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "bun:sqlite";
import { parseConfig } from "./config";
import { ensureAuditSchema, validateConfigPlaceholders } from "./init";

const VALID_CONFIG = parseConfig({
	credentials: {
		username: "app_user",
		password_env: "ORACLE_DB_PASSWORD",
	},
	defaults: {
		timeout_seconds: 30,
		max_rows: 1000,
	},
	environments: {
		dev: {
			hostname: "db.example.com",
			port: 1521,
			service: "DEVDB",
			allowlist_enabled: false,
		},
	},
});

describe("validateConfigPlaceholders", () => {
	test("passes when placeholders are replaced", () => {
		expect(() => validateConfigPlaceholders(VALID_CONFIG)).not.toThrow();
	});

	test("fails when top-level username placeholder remains", () => {
		const config = parseConfig({
			...VALID_CONFIG,
			credentials: {
				...VALID_CONFIG.credentials,
				username: "CHANGE_ME",
			},
		});
		expect(() => validateConfigPlaceholders(config)).toThrow("placeholder");
	});

	test("fails when environment host/service placeholders remain", () => {
		const config = parseConfig({
			...VALID_CONFIG,
			environments: {
				dev: {
					...VALID_CONFIG.environments.dev,
					hostname: "CHANGE_ME",
				},
			},
		});
		expect(() => validateConfigPlaceholders(config)).toThrow("placeholder");
	});

	test("fails when environment-level credential username placeholder remains", () => {
		const config = parseConfig({
			...VALID_CONFIG,
			environments: {
				dev: {
					...VALID_CONFIG.environments.dev,
					credentials: {
						username: "CHANGE_ME",
						password_env: "ORACLE_DB_PASSWORD_DEV",
					},
				},
			},
		});
		expect(() => validateConfigPlaceholders(config)).toThrow("placeholder");
	});
});

describe("ensureAuditSchema", () => {
	test("creates query_log table when database file already exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "oracle-db-proxy-init-test-"));
		const dbPath = join(dir, "audit.db");

		try {
			// Create an empty SQLite file with no schema.
			const emptyDb = new Database(dbPath);
			emptyDb.close();

			expect(ensureAuditSchema(dbPath)).toBe(false);

			const verifyDb = new Database(dbPath, { readonly: true });
			const row = verifyDb
				.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'query_log'")
				.get() as { name?: string } | null;
			verifyDb.close();

			expect(row?.name).toBe("query_log");
		}
		finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
