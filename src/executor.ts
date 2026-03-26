import type { ResolvedEnvironment } from "./config";
import { getConnection } from "./connection";
import { validateQuery } from "./validator";
import { logQuery } from "./audit";
import oracledb from "oracledb";

/** Successful query execution result with rows and metadata. */
export type QuerySuccess = {
	rows: Record<string, unknown>[];
	row_count: number;
	total_rows: number;
	truncated: boolean;
	warning?: string;
	execution_ms: number;
};

/** Returned when the SQL fails safety validation (not a runtime error). */
export type QueryRejection = {
	error: "QUERY_REJECTED";
	reason: string;
	sql: string;
};

/** Returned when an unexpected runtime error occurs (e.g. connection failure). */
export type QueryError = {
	error: "EXECUTION_ERROR";
	message: string;
	environment: string;
};

/** Discriminated union of all possible `executeQuery` outcomes. */
export type QueryResult = QuerySuccess | QueryRejection | QueryError;

function isOracleTimeoutError(error: unknown, message: string): boolean {
	if (!error || typeof error !== "object") {
		return message.includes("NJS-123");
	}

	const withErrorNum = error as { errorNum?: unknown };
	return withErrorNum.errorNum === 1013 || message.includes("NJS-123");
}

export function isResultTruncated(totalRows: number, maxRows: number): boolean {
	return totalRows > maxRows;
}

export function normalizeSqlInput(sql: string): string {
	return sql.trim().replace(/;+$/g, "").trim();
}

/**
 * Converts Oracle-specific column values (LOBs, Dates, Buffers) into
 * JSON-safe primitives so that `JSON.stringify` never hits cyclic references.
 */
function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
	const clean: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		if (value === null || value === undefined) {
			clean[key] = value;
		} else if (value instanceof Date) {
			clean[key] = value.toISOString();
		} else if (Buffer.isBuffer(value)) {
			clean[key] = value.toString("base64");
		} else if (typeof value === "object" && value !== null && typeof (value as any).getData === "function") {
			// Oracle LOB objects — skip (too large / cyclic); surface placeholder
			clean[key] = "[LOB]";
		} else if (typeof value === "bigint") {
			clean[key] = value.toString();
		} else {
			clean[key] = value;
		}
	}
	return clean;
}

/**
 * Validates and executes a SELECT query against the named environment.
 * Wraps the query with a ROWNUM limit and runs a COUNT(*) when the row limit is reached.
 * All outcomes (success, rejection, error) are audit-logged.
 */
export async function executeQuery(
	environmentName: string,
	env: ResolvedEnvironment,
	sql: string
): Promise<QueryResult> {
	const start = Date.now();
	const normalizedSql = normalizeSqlInput(sql);

	// Validate first - never touch the database if validation fails
	const validation = validateQuery(
		normalizedSql,
		env.allowlist_enabled ? env.allowed_tables : undefined,
		env.username
	);

	if(!validation.valid){
		logQuery({
			environment: environmentName,
			status: "rejected",
			sql_text: sql,
			rejection_reason: validation.reason,
			truncated: false,
		});
		return {error: "QUERY_REJECTED", reason: validation.reason, sql};
	}

	let connection;
	try {
		connection = await getConnection(environmentName, env);


		// Fetch rows up to the max_rows limit
		const dataResult = await connection.execute<Record<string, unknown>>(
			`SELECT * FROM (${normalizedSql}) WHERE ROWNUM <= :maxRows`,
			{maxRows: env.max_rows},
			{outFormat: oracledb.OUT_FORMAT_OBJECT}
		);

		const rows = (dataResult.rows ?? []).map(sanitizeRow);
		const hitLimit = rows.length === env.max_rows;

		// Only run count query if we hit the limit - otherwise we already have everything
		let total_rows = rows.length;
		if (hitLimit) {
			// Get total row count
			const countResult = await connection.execute<[number]>(
				`SELECT COUNT(*) from (${normalizedSql})`,
				[],
				{outFormat: oracledb.OUT_FORMAT_ARRAY}
			);
			total_rows = countResult.rows?.[0]?.[0] ?? 0;
		}

		const truncated = isResultTruncated(total_rows, env.max_rows);
		const execution_ms = Date.now() - start;

		logQuery({
			environment: environmentName,
			status: "executed",
			sql_text: sql,
			row_count: rows.length,
			execution_ms,
			truncated
		});
	
		const result: QuerySuccess = {
			rows,
			row_count: rows.length,
			total_rows,
			truncated,
			execution_ms,
		};

		if(truncated){
			result.warning = `Result set has ${total_rows} total rows but is limited to ${env.max_rows}. Refine your WHERE clause to narrow results, or use OFFSET/FETCH NEXT for pagination.`;
		}

		return result;

	}
	catch(e){
		const execution_ms = Date.now() - start;
		const message = e instanceof Error ? e.message : String(e);

		// Detect Oracle timeout (ORA-01013 or NJS-123)
		const isTimeout = isOracleTimeoutError(e, message);

		if(isTimeout){
			logQuery({
				environment: environmentName,
				status: "timeout",
				sql_text: sql,
				execution_ms,
				truncated: true,
			});
			return {
				rows: [],
				row_count: 0,
				total_rows: 0,
				truncated: true,
				warning: `Query exceeded the time limit of ${env.timeout_seconds} seconds and was cancelled. Consider adding WHERE clauses or filters to narrow the result set.`,
				execution_ms,
			};
		}

		logQuery({
			environment: environmentName,
			status: "error",
			sql_text: sql,
			rejection_reason: message,
			execution_ms,
			truncated: false,
		});

		return {error: "EXECUTION_ERROR", message, environment: environmentName};

	}
	finally {
		if(connection){
			try{
				await connection.close();
			}
			catch(e){
				console.error(`Failed to close connection: ${e}`);
			}
		}
	}

}
