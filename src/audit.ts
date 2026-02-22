import Database from "bun:sqlite";
import { createHash } from "crypto";
import { AUDIT_DB_PATH } from "./paths";

let _db: Database | null = null;

function getDb(): Database {
	if(!_db){
		_db = new Database(AUDIT_DB_PATH);
	}
	return _db;
}

/** Shape of a single audit log entry written to the `query_log` table. */
export type QueryLogEntry = {
	environment: string;
	status: "executed" | "rejected" | "timeout" | "error";
	sql_text: string;
	rejection_reason?: string;
	row_count?: number;
	execution_ms?: number;
	truncated: boolean;
};

/**
 * Writes a query event to the SQLite audit log. Fire-and-forget — failures
 * are logged to stderr but never propagate to the caller.
 */
export function logQuery(entry: QueryLogEntry): void {
	try {
		const sql_hash = createHash("sha256").update(entry.sql_text).digest("hex");

		const stmt = getDb().prepare(`
			INSERT INTO query_log (
				timestamp, environment, status, sql_hash, sql_text,
				rejection_reason, row_count, execution_ms, truncated
			)
			VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ?
			)
		`);

		stmt.run(
			new Date().toISOString(),
			entry.environment,
			entry.status,
			sql_hash,
			entry.sql_text,
			entry.rejection_reason ?? null,
			entry.row_count ?? null,
			entry.execution_ms ?? null,
			entry.truncated ? 1 : 0
		);
	}
	catch(e) {
		console.error(`Audit log write failed: ${e}`);
	}
}