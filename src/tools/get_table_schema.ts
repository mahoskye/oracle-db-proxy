import { z } from "zod";
import { loadConfig, resolveEnvironment } from "../config";
import { getConnection } from "../connection";
import oracledb from "oracledb";
import { isTableAllowed, normalizeIdentifier, parseIdentifierReference } from "./allowlist";

export const getTableSchemaSchema = {
	environment: z.string().trim().min(1).describe("Named environment from config (e.g. 'dev', 'test', 'prod')"),
	table: z.string().trim().min(1).describe("Table or view name to inspect."),
	schema: z.string().trim().min(1).optional().describe("Schema/owner name. Defaults to the connected user's schema"),
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

function parseTableReference(
	rawSchema: string | undefined,
	rawTable: string,
	defaultSchema: string
): { schemaFilter: string; tableFilter: string; dblinkFilter?: string; inputError?: string } {
	const normalizedDefaultSchema = normalizeIdentifier(defaultSchema);
	const normalizedSchema = rawSchema ? normalizeIdentifier(rawSchema) : "";

	if (rawSchema && normalizedSchema.includes("@")) {
		return {
			schemaFilter: normalizedSchema,
			tableFilter: normalizeIdentifier(rawTable),
			inputError: "Schema argument must not include a database link. Put the database link in the table argument instead.",
		};
	}

	const parsed = parseIdentifierReference(rawTable);
	if (!parsed) {
		return {
			schemaFilter: normalizedSchema || normalizedDefaultSchema,
			tableFilter: normalizeIdentifier(rawTable),
			inputError: "Table name must be a valid Oracle identifier.",
		};
	}

	if (normalizedSchema && parsed.owner && normalizedSchema !== parsed.owner) {
		return {
			schemaFilter: normalizedSchema,
			tableFilter: parsed.table,
			dblinkFilter: parsed.dblink,
			inputError: `Conflicting schema values provided: schema=${normalizedSchema}, table=${parsed.full}.`,
		};
	}

	return {
		schemaFilter: normalizedSchema || parsed.owner || normalizedDefaultSchema,
		tableFilter: parsed.table,
		dblinkFilter: parsed.dblink,
	};
}

function formatObjectReference(owner: string, table: string, dblink?: string): string {
	return dblink ? `${owner}.${table}@${dblink}` : `${owner}.${table}`;
}

/** MCP handler for `get_table_schema`. Queries ALL_TAB_COLUMNS and ALL_COL_COMMENTS for column metadata. */
export async function getTableSchemaHandlerWithDeps(
	{ environment, table, schema }: { environment: string, table: string, schema?: string },
	deps: GetTableSchemaDeps = DEFAULT_DEPS
){
	let connection;
	try {
		const config = deps.loadConfig();
		const env = deps.resolveEnvironment(config, environment);
		const { schemaFilter, tableFilter, dblinkFilter, inputError } = parseTableReference(schema, table, env.username);

		if (inputError) {
			return {
				content: [{
					type: "text" as const,
					text: JSON.stringify({
						error: "INVALID_ARGUMENT",
						message: inputError,
						environment,
					}, null, 2),
				}],
			};
		}

		if (
			env.allowlist_enabled &&
			!isTableAllowed(env.allowed_tables, tableFilter, schemaFilter, env.username, dblinkFilter)
		) {
			const objectRef = formatObjectReference(schemaFilter, tableFilter, dblinkFilter);
			return {
				content: [{
					type: "text" as const,
					text: JSON.stringify({
						error: "ACCESS_DENIED",
						message: `Table ${objectRef} is not in the allowlist for this environment.`,
						environment,
						owner: schemaFilter,
						table: tableFilter,
						dblink: dblinkFilter ?? null,
					}, null, 2),
				}],
			};
		}

		connection = await deps.getConnection(environment, env);
		const dbLinkSuffix = dblinkFilter ? `@${dblinkFilter}` : "";

		const result = await connection.execute<Record<string, unknown>>(
			`
				SELECT c.column_name AS name,
					   c.column_id AS position,
					   c.data_type,
					   CASE WHEN c.nullable = 'Y' THEN 1 ELSE 0 END AS nullable,
					   cc.comments AS "comment"
				FROM all_tab_columns${dbLinkSuffix} c
				LEFT JOIN all_col_comments${dbLinkSuffix} cc
					ON cc.owner = c.owner
					AND cc.table_name = c.table_name
					AND cc.column_name = c.column_name
				WHERE c.owner = :owner
					AND c.table_name = :table_name
				ORDER BY c.column_id
			`,
			{ owner: schemaFilter, table_name: tableFilter },
			{ outFormat: oracledb.OUT_FORMAT_OBJECT }
		);

		if ((result.rows ?? []).length === 0) {
			const objectRef = formatObjectReference(schemaFilter, tableFilter, dblinkFilter);
			return {
				content: [{
					type: "text" as const,
					text: JSON.stringify({
						error: "TABLE_NOT_FOUND",
						message: `Table or view ${objectRef} was not found or is not visible to the connected user.`,
						environment,
						owner: schemaFilter,
						table: tableFilter,
						dblink: dblinkFilter ?? null,
					}, null, 2),
				}],
			};
		}

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
					dblink: dblinkFilter ?? null,
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
