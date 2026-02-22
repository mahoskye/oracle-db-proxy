import { describe, expect, test } from "bun:test";
import { parseConfig } from "./config";

const BASE_CONFIG = {
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
			allowlist_enabled: true,
			allowed_tables: ["EMPLOYEES"],
		},
	},
};

describe("parseConfig", () => {
	test("accepts a valid config", () => {
		const parsed = parseConfig(BASE_CONFIG);
		expect(parsed.environments.dev?.allowlist_enabled).toBe(true);
	});

	test("rejects unknown top-level keys", () => {
		expect(() =>
			parseConfig({
				...BASE_CONFIG,
				unknown_top_level: true,
			})
		).toThrow("Invalid config");
	});

	test("rejects unknown environment keys", () => {
		expect(() =>
			parseConfig({
				...BASE_CONFIG,
				environments: {
					dev: {
						...BASE_CONFIG.environments.dev,
						allowlist_enable: true,
					},
				},
			})
		).toThrow("Invalid config");
	});
});

