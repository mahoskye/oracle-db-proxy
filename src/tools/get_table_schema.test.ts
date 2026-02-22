import { describe, expect, jest, test } from "bun:test";
import type { ResolvedEnvironment } from "../config";
import {
	getTableSchemaHandlerWithDeps,
	type GetTableSchemaDeps,
} from "./get_table_schema";

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

describe("getTableSchemaHandlerWithDeps", () => {
	test("returns ACCESS_DENIED and skips DB call when table is not allowlisted", async () => {
		const getConnection = jest.fn(async () => ({}));
		const deps: GetTableSchemaDeps = {
			loadConfig: () => ({} as never),
			resolveEnvironment: () => ({
				...BASE_ENV,
				allowlist_enabled: true,
				allowed_tables: ["EMPLOYEES"],
			}),
			getConnection: getConnection as never,
		};

		const response = await getTableSchemaHandlerWithDeps(
			{ environment: "dev", schema: "hr", table: "secret_table" },
			deps
		) as ToolResult;
		const payload = parseToolText(response);

		expect(payload).toEqual({
			error: "ACCESS_DENIED",
			message: "Table HR.SECRET_TABLE is not in the allowlist for this environment.",
			environment: "dev",
			owner: "HR",
			table: "SECRET_TABLE",
		});
		expect(getConnection).not.toHaveBeenCalled();
	});

	test("returns column metadata and closes connection on success", async () => {
		const execute = jest.fn(async (_sql: string, binds: unknown) => {
			expect(binds).toEqual({ schema: "HR", table: "EMPLOYEES" });
			return {
				rows: [
					{
						NAME: "EMPLOYEE_ID",
						POSITION: 1,
						DATA_TYPE: "NUMBER",
						NULLABLE: 0,
						COMMENT: "Primary key",
					},
					{
						NAME: "LAST_NAME",
						POSITION: 2,
						DATA_TYPE: "VARCHAR2",
						NULLABLE: 1,
						COMMENT: null,
					},
				],
			};
		});
		const close = jest.fn(async () => {});
		const deps: GetTableSchemaDeps = {
			loadConfig: () => ({} as never),
			resolveEnvironment: () => BASE_ENV,
			getConnection: async () => ({ execute, close } as never),
		};

		const response = await getTableSchemaHandlerWithDeps(
			{ environment: "dev", schema: "hr", table: "employees" },
			deps
		) as ToolResult;
		const payload = parseToolText(response);

		expect(payload.table).toBe("EMPLOYEES");
		expect(payload.owner).toBe("HR");
		expect(payload.environment).toBe("dev");
		expect(payload.columns).toEqual([
			{
				name: "EMPLOYEE_ID",
				position: 1,
				data_type: "NUMBER",
				nullable: false,
				comment: "Primary key",
			},
			{
				name: "LAST_NAME",
				position: 2,
				data_type: "VARCHAR2",
				nullable: true,
				comment: null,
			},
		]);
		expect(close).toHaveBeenCalledTimes(1);
	});

	test("returns execution error payload and closes connection when query fails", async () => {
		const execute = jest.fn(async () => {
			throw new Error("metadata query failed");
		});
		const close = jest.fn(async () => {});
		const deps: GetTableSchemaDeps = {
			loadConfig: () => ({} as never),
			resolveEnvironment: () => BASE_ENV,
			getConnection: async () => ({ execute, close } as never),
		};

		const response = await getTableSchemaHandlerWithDeps(
			{ environment: "dev", table: "employees" },
			deps
		) as ToolResult;
		const payload = parseToolText(response);

		expect(payload).toMatchObject({
			error: "EXECUTION_ERROR",
			environment: "dev",
		});
		expect(String(payload.message)).toContain("metadata query failed");
		expect(close).toHaveBeenCalledTimes(1);
	});
});
