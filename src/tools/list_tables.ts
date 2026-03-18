import { z } from "zod";
import { loadConfig, resolveEnvironment } from "../config";
import { getConnection } from "../connection";
import oracledb from "oracledb";
import { isTableAllowed, normalizeIdentifier } from "./allowlist";

export const listTablesSchema = {
	environment: z.string().trim().min(1).describe("Named environment from config (e.g. 'dev', 'test', 'prod')"),
	schema: z.string().trim().min(1).optional().describe("Schema/owner name to filter by. Defaults to the connected user's schema."),
};

export type ListTablesDeps = {
	loadConfig: typeof loadConfig;
	resolveEnvironment: typeof resolveEnvironment;
	getConnection: typeof getConnection;
};

const DEFAULT_DEPS: ListTablesDeps = {
	loadConfig,
	resolveEnvironment,
	getConnection,
};

/** MCP handler for `list_tables`. Queries ALL_TABLES/ALL_VIEWS and filters by allowlist when enabled. */
export async function listTablesHandlerWithDeps(
	{ environment, schema }: { environment: string; schema?: string },
	deps: ListTablesDeps = DEFAULT_DEPS
){
	let connection;
	try {
		const config = deps.loadConfig();
		const env = deps.resolveEnvironment(config, environment);
		const schemaFilter = normalizeIdentifier(schema ?? env.username);

		if (schemaFilter.includes("@")) {
			return {
				content: [{
					type: "text" as const,
					text: JSON.stringify({
						error: "INVALID_ARGUMENT",
						message: "Schema argument must not include a database link. list_tables only supports local schema discovery.",
						environment,
					}, null, 2),
				}],
			};
		}

		connection = await deps.getConnection(environment, env);

		const result = await connection.execute<Record<string, unknown>>(
			`
				SELECT table_name as name, owner, 'TABLE' as type, num_rows as estimated_rows
				FROM all_tables
				WHERE owner = :schema
				UNION ALL 
				SELECT view_name as name, owner, 'VIEW' as type, NULL as estimated_rows
				FROM all_views
				WHERE owner = :schema
				ORDER BY type, name
			`,
			{ schema: schemaFilter },
			{ outFormat: oracledb.OUT_FORMAT_OBJECT }
		);

		let tables = (result.rows ?? []).map((row) => ({
			name: String(row["NAME"]),
			owner: String(row["OWNER"]),
			type: String(row["TYPE"]),
			estimated_rows: row["ESTIMATED_ROWS"] == null ? null : Number(row["ESTIMATED_ROWS"]),
		}));

		// Apply allow list filter if enabled
		if(env.allowlist_enabled){
			tables = tables.filter((table) =>
				isTableAllowed(env.allowed_tables, table.name, table.owner, env.username)
			);
		}

		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({
					tables,
					count: tables.length,
					schema: schemaFilter,
					environment,
				}, null, 2),
			}],
		};
	}
	catch(e){
		const message = e instanceof Error ? e.message : String(e);
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({error: "EXECUTION_ERROR", message, environment}, null, 2),
			}],
		};
	}
	finally{
		if(connection){
			try{
				await connection.close();
			}
			catch{}
		}
	}

}

export async function listTablesHandler(
	args: { environment: string; schema?: string }
){
	return listTablesHandlerWithDeps(args);
}
