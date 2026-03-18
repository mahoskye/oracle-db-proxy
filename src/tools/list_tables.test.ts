import { describe, expect, jest, test } from "bun:test";
import type { ResolvedEnvironment } from "../config";
import { listTablesHandlerWithDeps, type ListTablesDeps } from "./list_tables";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
};

function parseToolText(result: ToolResult): Record<string, unknown> {
	return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

const BASE_ENV: ResolvedEnvironment = {
	hostname: "db.example.com",
	port: 1521,
	service: "DEV",
	allowlist_enabled: false,
	allowed_tables: [],
	timeout_seconds: 30,
	max_rows: 1000,
	username: "HR",
	password: "secret",
};

describe("listTablesHandlerWithDeps", () => {
	test("filters tables by allowlist and returns normalized response", async () => {
		const execute = jest.fn(async (_sql: string, binds: unknown) => {
			expect(binds).toEqual({ schema: "HR" });
			return {
				rows: [
					{ NAME: "EMPLOYEES", OWNER: "HR", TYPE: "TABLE", ESTIMATED_ROWS: 10 },
					{ NAME: "SECRET_TABLE", OWNER: "HR", TYPE: "TABLE", ESTIMATED_ROWS: 3 },
				],
			};
		});
		const close = jest.fn(async () => {});
		const deps: ListTablesDeps = {
			loadConfig: () => ({} as never),
			resolveEnvironment: () => ({
				...BASE_ENV,
				allowlist_enabled: true,
				allowed_tables: ["EMPLOYEES"],
			}),
			getConnection: async () => ({ execute, close } as never),
		};

		const response = await listTablesHandlerWithDeps({ environment: "dev", schema: "hr" }, deps) as ToolResult;
		const payload = parseToolText(response);

		expect(payload.environment).toBe("dev");
		expect(payload.schema).toBe("HR");
		expect(payload.count).toBe(1);
		expect(payload.tables).toEqual([
			{ name: "EMPLOYEES", owner: "HR", type: "TABLE", estimated_rows: 10 },
		]);
		expect(close).toHaveBeenCalledTimes(1);
	});

	test("preserves quoted schema case for Oracle metadata lookup", async () => {
		const execute = jest.fn(async (_sql: string, binds: unknown) => {
			expect(binds).toEqual({ schema: "Hr" });
			return { rows: [] };
		});
		const close = jest.fn(async () => {});
		const deps: ListTablesDeps = {
			loadConfig: () => ({} as never),
			resolveEnvironment: () => BASE_ENV,
			getConnection: async () => ({ execute, close } as never),
		};

		const response = await listTablesHandlerWithDeps(
			{ environment: "dev", schema: '"Hr"' },
			deps
		) as ToolResult;
		const payload = parseToolText(response);

		expect(payload.schema).toBe("Hr");
		expect(close).toHaveBeenCalledTimes(1);
	});

	test("rejects schema arguments that include a database link", async () => {
		const getConnection = jest.fn(async () => ({}));
		const deps: ListTablesDeps = {
			loadConfig: () => ({} as never),
			resolveEnvironment: () => BASE_ENV,
			getConnection: getConnection as never,
		};

		const response = await listTablesHandlerWithDeps(
			{ environment: "dev", schema: "hr@test.dev2" },
			deps
		) as ToolResult;
		const payload = parseToolText(response);

		expect(payload).toEqual({
			error: "INVALID_ARGUMENT",
			message: "Schema argument must not include a database link. list_tables only supports local schema discovery.",
			environment: "dev",
		});
		expect(getConnection).not.toHaveBeenCalled();
	});

	test("returns execution error payload when query fails", async () => {
		const execute = jest.fn(async () => {
			throw new Error("boom");
		});
		const close = jest.fn(async () => {});
		const deps: ListTablesDeps = {
			loadConfig: () => ({} as never),
			resolveEnvironment: () => BASE_ENV,
			getConnection: async () => ({ execute, close } as never),
		};

		const response = await listTablesHandlerWithDeps({ environment: "dev" }, deps) as ToolResult;
		const payload = parseToolText(response);

		expect(payload).toMatchObject({
			error: "EXECUTION_ERROR",
			environment: "dev",
		});
		expect(String(payload.message)).toContain("boom");
		expect(close).toHaveBeenCalledTimes(1);
	});
});
