import { z } from "zod";
import { loadConfig, resolveEnvironment } from "../config";
import { getConnection } from "../connection";
import oracledb from "oracledb";
import { isTableAllowed } from "./allowlist";

export const getTableSchemaSchema = {
	environment: z.string().describe("Named environment from config (e.g. 'dev', 'test', 'prod')"),
	table: z.string().describe("Table or view name to inspect."),
	schema: z.string().optional().describe("Schema/owner name. Defaults to the connected user's schema"),
};

export type GetTableSchemaDeps = {
	loadConfig: typeof loadConfig;
	resolveEnvironment: typeof resolveEnvironment;
	getConnection: typeof getConnection;
};

const DEFAULT_DEPS: GetTableSchemaDeps = {
	loadConfig,
	resolveEnvironment,
	getConnection,
};

/** MCP handler for `get_table_schema`. Queries ALL_TAB_COLUMNS and ALL_COL_COMMENTS for column metadata. */
export async function getTableSchemaHandlerWithDeps(
	{ environment, table, schema }: { environment: string, table: string, schema?: string },
	deps: GetTableSchemaDeps = DEFAULT_DEPS
){
	let connection;
	try {
		const config = deps.loadConfig();
		const env = deps.resolveEnvironment(config, environment);
		const schemaFilter = (schema ?? env.username).toUpperCase();
		const tableFilter = table.toUpperCase();

		if (
			env.allowlist_enabled &&
			!isTableAllowed(env.allowed_tables, tableFilter, schemaFilter, env.username)
		) {
			return {
				content: [{
					type: "text" as const,
					text: JSON.stringify({
						error: "ACCESS_DENIED",
						message: `Table ${schemaFilter}.${tableFilter} is not in the allowlist for this environment.`,
						environment,
						owner: schemaFilter,
						table: tableFilter,
					}, null, 2),
				}],
			};
		}

		connection = await deps.getConnection(environment, env);

		const result = await connection.execute<Record<string, unknown>>(
			`
				SELECT c.column_name AS name,
					   c.column_id AS position,
					   c.data_type,
					   CASE WHEN c.nullable = 'Y' THEN 1 ELSE 0 END AS nullable,
					   cc.comments AS comment
				FROM all_tab_columns c
				LEFT JOIN all_col_comments cc
					ON cc.owner = c.owner
					AND cc.table_name = c.table_name
					AND cc.column_name = c.column_name
				WHERE c.owner = :schema
					AND c.table_name = :table
				ORDER BY c.column_id
			`,
			{ schema: schemaFilter, table: tableFilter },
			{ outFormat: oracledb.OUT_FORMAT_OBJECT }
		);

		const columns = (result.rows ?? []).map((row) => ({
			name: String(row["NAME"]),
			position: Number(row["POSITION"]),
			data_type: String(row["DATA_TYPE"]),
			nullable: row["NULLABLE"] === 1,
			comment: row["COMMENT"] == null ? null : String(row["COMMENT"]),
		}));

		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({
					table: tableFilter,
					owner: schemaFilter,
					environment,
					columns,
				}, null, 2),
			}],
		};
	}
	catch(e) {
		const message = e instanceof Error ? e.message : String(e);
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({ error: "EXECUTION_ERROR", message, environment }, null, 2),
			}],
		};
	}
	finally {
		if(connection){
			try {
				await connection.close();
			}
			catch {}
		}
	}
}

export async function getTableSchemaHandler(
	args: { environment: string, table: string, schema?: string }
){
	return getTableSchemaHandlerWithDeps(args);
}
