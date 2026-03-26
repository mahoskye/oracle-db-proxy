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
			dblink: null,
		});
		expect(getConnection).not.toHaveBeenCalled();
	});

	test("returns column metadata and closes connection on success", async () => {
		const execute = jest.fn(async (_sql: string, binds: unknown) => {
			expect(binds).toEqual({ owner: "HR", table_name: "EMPLOYEES" });
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
		expect(payload.dblink).toBeNull();
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

	test("accepts schema-qualified table names in the table argument", async () => {
		const execute = jest.fn(async (_sql: string, binds: unknown) => {
			expect(binds).toEqual({ owner: "HR", table_name: "EMPLOYEES" });
			return {
				rows: [
					{
						NAME: "EMPLOYEE_ID",
						POSITION: 1,
						DATA_TYPE: "NUMBER",
						NULLABLE: 0,
						COMMENT: "Primary key",
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
			{ environment: "dev", table: "hr.employees" },
			deps
		) as ToolResult;
		const payload = parseToolText(response);

		expect(payload.owner).toBe("HR");
		expect(payload.table).toBe("EMPLOYEES");
		expect(payload.dblink).toBeNull();
		expect(close).toHaveBeenCalledTimes(1);
	});

	test("preserves quoted identifier case for Oracle lookups", async () => {
		const execute = jest.fn(async (_sql: string, binds: unknown) => {
			expect(binds).toEqual({ owner: "Hr", table_name: "Employees" });
			return {
				rows: [
					{
						NAME: "EmployeeId",
						POSITION: 1,
						DATA_TYPE: "NUMBER",
						NULLABLE: 0,
						COMMENT: null,
					},
				],
			};
		});
		const close = jest.fn(async () => {});
		const deps: GetTableSchemaDeps = {
			loadConfig: () => ({} as never),
			resolveEnvironment: () => ({ ...BASE_ENV, username: "Hr" }),
			getConnection: async () => ({ execute, close } as never),
		};

		const response = await getTableSchemaHandlerWithDeps(
			{ environment: "dev", table: '"Hr"."Employees"' },
			deps
		) as ToolResult;
		const payload = parseToolText(response);

		expect(payload.owner).toBe("Hr");
		expect(payload.table).toBe("Employees");
		expect(payload.dblink).toBeNull();
		expect(close).toHaveBeenCalledTimes(1);
	});

	test("queries remote metadata over a database link", async () => {
		const execute = jest.fn(async (sql: string, binds: unknown) => {
			expect(sql).toContain("FROM all_tab_columns@TEST.DEV2 c");
			expect(sql).toContain("LEFT JOIN all_col_comments@TEST.DEV2 cc");
			expect(binds).toEqual({ owner: "HR", table_name: "EMPLOYEES" });
			return {
				rows: [
					{
						NAME: "EMPLOYEE_ID",
						POSITION: 1,
						DATA_TYPE: "NUMBER",
						NULLABLE: 0,
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
			{ environment: "dev", table: "hr.employees@test.dev2" },
			deps
		) as ToolResult;
		const payload = parseToolText(response);

		expect(payload.owner).toBe("HR");
		expect(payload.table).toBe("EMPLOYEES");
		expect(payload.dblink).toBe("TEST.DEV2");
		expect(close).toHaveBeenCalledTimes(1);
	});

	test("returns INVALID_ARGUMENT for conflicting schema inputs", async () => {
		const getConnection = jest.fn(async () => ({}));
		const deps: GetTableSchemaDeps = {
			loadConfig: () => ({} as never),
			resolveEnvironment: () => BASE_ENV,
			getConnection: getConnection as never,
		};

		const response = await getTableSchemaHandlerWithDeps(
			{ environment: "dev", schema: "sales", table: "hr.employees" },
			deps
		) as ToolResult;
		const payload = parseToolText(response);

		expect(payload).toEqual({
			error: "INVALID_ARGUMENT",
			message: "Conflicting schema values provided: schema=SALES, table=HR.EMPLOYEES.",
			environment: "dev",
		});
		expect(getConnection).not.toHaveBeenCalled();
	});

	test("rejects schema arguments that include a database link", async () => {
		const getConnection = jest.fn(async () => ({}));
		const deps: GetTableSchemaDeps = {
			loadConfig: () => ({} as never),
			resolveEnvironment: () => BASE_ENV,
			getConnection: getConnection as never,
		};

		const response = await getTableSchemaHandlerWithDeps(
			{ environment: "dev", schema: "hr@test.dev2", table: "employees" },
			deps
		) as ToolResult;
		const payload = parseToolText(response);

		expect(payload).toEqual({
			error: "INVALID_ARGUMENT",
			message: "Schema argument must not include a database link. Put the database link in the table argument instead.",
			environment: "dev",
		});
		expect(getConnection).not.toHaveBeenCalled();
	});

	test("returns TABLE_NOT_FOUND when metadata query returns no columns", async () => {
		const execute = jest.fn(async () => ({ rows: [] }));
		const close = jest.fn(async () => {});
		const deps: GetTableSchemaDeps = {
			loadConfig: () => ({} as never),
			resolveEnvironment: () => BASE_ENV,
			getConnection: async () => ({ execute, close } as never),
		};

		const response = await getTableSchemaHandlerWithDeps(
			{ environment: "dev", table: "missing_table" },
			deps
		) as ToolResult;
		const payload = parseToolText(response);

		expect(payload).toEqual({
			error: "TABLE_NOT_FOUND",
			message: "Table or view HR.MISSING_TABLE was not found or is not visible to the connected user.",
			environment: "dev",
			owner: "HR",
			table: "MISSING_TABLE",
			dblink: null,
		});
		expect(close).toHaveBeenCalledTimes(1);
	});

	test("returns TABLE_NOT_FOUND for remote objects when metadata query returns no columns", async () => {
		const execute = jest.fn(async () => ({ rows: [] }));
		const close = jest.fn(async () => {});
		const deps: GetTableSchemaDeps = {
			loadConfig: () => ({} as never),
			resolveEnvironment: () => BASE_ENV,
			getConnection: async () => ({ execute, close } as never),
		};

		const response = await getTableSchemaHandlerWithDeps(
			{ environment: "dev", table: "employees@test.dev2" },
			deps
		) as ToolResult;
		const payload = parseToolText(response);

		expect(payload).toEqual({
			error: "TABLE_NOT_FOUND",
			message: "Table or view HR.EMPLOYEES@TEST.DEV2 was not found or is not visible to the connected user.",
			environment: "dev",
			owner: "HR",
			table: "EMPLOYEES",
			dblink: "TEST.DEV2",
		});
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
