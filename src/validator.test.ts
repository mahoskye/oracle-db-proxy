import { test, expect, describe } from "bun:test";
import { validateQuery } from "./validator";

describe("validateQuery", () => {
	// --- Parsing ---

	test("valid SELECT passes", () => {
		const result = validateQuery("SELECT 1 FROM dual");
		expect(result.valid).toBe(true);
	});

	test("Oracle FETCH FIRST syntax passes", () => {
		const result = validateQuery("SELECT * FROM employees FETCH FIRST 10 ROWS ONLY");
		expect(result.valid).toBe(true);
	});

	test("Oracle OFFSET ... FETCH NEXT syntax passes", () => {
		const result = validateQuery("SELECT * FROM employees OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY");
		expect(result.valid).toBe(true);
	});

	test("Oracle CONNECT BY syntax passes", () => {
		const result = validateQuery(
			"SELECT employee_id, manager_id FROM employees CONNECT BY PRIOR employee_id = manager_id START WITH manager_id IS NULL"
		);
		expect(result.valid).toBe(true);
	});

	test("SELECT FOR UPDATE is rejected", () => {
		const result = validateQuery("SELECT * FROM employees FOR UPDATE");
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain("FOR UPDATE");
		}
	});

	test("garbage SQL is rejected", () => {
		const result = validateQuery("NOT VALID SQL AT ALL ???");
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain("could not be parsed");
		}
	});

	// --- Statement count ---

	test("multiple statements rejected", () => {
		const result = validateQuery("SELECT 1 FROM dual; SELECT 2 FROM dual");
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain("Multiple statements");
		}
	});

	// --- Root statement type ---

	test("INSERT at root rejected", () => {
		const result = validateQuery("INSERT INTO foo (a) VALUES (1)");
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain("INSERT");
			expect(result.reason).toContain("not permitted");
		}
	});

	test("UPDATE at root rejected", () => {
		const result = validateQuery("UPDATE foo SET a = 1");
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain("UPDATE");
		}
	});

	test("CREATE at root rejected", () => {
		const result = validateQuery("CREATE TABLE foo (a INT)");
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain("CREATE");
		}
	});

	// --- Parse-tree walk: write operations ---

	test("INSERT in subquery rejected", () => {
		// May fail at parse or forbidden-operation walk — either way it should not pass.
		const result = validateQuery("SELECT * FROM (INSERT INTO foo VALUES (1))");
		expect(result.valid).toBe(false);
	});

	// --- Parse-tree walk: DDL operations ---

	test("DROP rejected", () => {
		const result = validateQuery("DROP TABLE foo");
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain("DROP");
		}
	});

	test("ALTER rejected", () => {
		const result = validateQuery("ALTER TABLE foo ADD (b NUMBER)");
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain("ALTER");
		}
	});

	test("TRUNCATE rejected", () => {
		const result = validateQuery("TRUNCATE TABLE foo");
		expect(result.valid).toBe(false);
	});

	test("RENAME rejected", () => {
		const result = validateQuery("RENAME foo TO bar");
		// May fail at parse or at walk — either way it should not pass
		expect(result.valid).toBe(false);
	});

	// --- Parse-tree walk: exec operations ---

	test("CALL rejected", () => {
		const result = validateQuery("CALL my_proc()");
		expect(result.valid).toBe(false);
	});

	// --- Allowlist ---

	test("table in allowlist passes", () => {
		const result = validateQuery("SELECT * FROM employees", ["EMPLOYEES"]);
		expect(result.valid).toBe(true);
	});

	test("table not in allowlist rejected", () => {
		const result = validateQuery("SELECT * FROM secret_table", ["EMPLOYEES", "DEPARTMENTS"]);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain("allowlist");
			expect(result.reason).toContain("SECRET_TABLE");
		}
	});

	test("empty allowlist rejects everything", () => {
		const result = validateQuery("SELECT * FROM employees", []);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain("allowlist");
		}
	});

	// --- Edge cases ---

	test("SELECT with JOIN passes", () => {
		const result = validateQuery("SELECT a.id, b.name FROM foo a JOIN bar b ON a.id = b.foo_id");
		expect(result.valid).toBe(true);
	});

	test("SELECT * passes", () => {
		const result = validateQuery("SELECT * FROM dual");
		expect(result.valid).toBe(true);
	});

	test("UNION SELECT passes", () => {
		const result = validateQuery("SELECT 1 AS n FROM dual UNION ALL SELECT 2 AS n FROM dual");
		expect(result.valid).toBe(true);
	});

	test("allowlist is case-insensitive", () => {
		const result = validateQuery("SELECT * FROM Employees", ["employees"]);
		expect(result.valid).toBe(true);
	});

	test("CTE names do not require allowlist entries", () => {
		const result = validateQuery(
			"WITH cte AS (SELECT * FROM employees) SELECT * FROM cte",
			["EMPLOYEES"]
		);
		expect(result.valid).toBe(true);
	});

	test("schema-qualified table does not match unqualified allowlist without default schema", () => {
		const result = validateQuery("SELECT * FROM hr.employees", ["EMPLOYEES"]);
		expect(result.valid).toBe(false);
	});

	test("schema-qualified table matches unqualified allowlist in default schema", () => {
		const result = validateQuery("SELECT * FROM hr.employees", ["EMPLOYEES"], "HR");
		expect(result.valid).toBe(true);
	});

	test("schema-qualified table requires qualified allowlist when schema differs from default", () => {
		const result = validateQuery("SELECT * FROM hr.employees", ["EMPLOYEES"], "SCOTT");
		expect(result.valid).toBe(false);
	});

	test("quoted identifiers preserve case in allowlist checks", () => {
		const result = validateQuery(
			'SELECT * FROM "Hr"."Employees"',
			['"Hr"."Employees"'],
			"SCOTT"
		);
		expect(result.valid).toBe(true);
	});

	test("quoted identifiers reject mismatched case in allowlist checks", () => {
		const result = validateQuery(
			'SELECT * FROM "Hr"."Employees"',
			['"HR"."EMPLOYEES"'],
			"SCOTT"
		);
		expect(result.valid).toBe(false);
	});

	test("database link references are checked against allowlist", () => {
		const result = validateQuery(
			"SELECT * FROM employees@test.dev2",
			["EMPLOYEES@TEST.DEV2"],
			"HR"
		);
		expect(result.valid).toBe(true);
	});

	test("schema-qualified database link references are checked against allowlist", () => {
		const result = validateQuery(
			"SELECT * FROM hr.employees@test.dev2",
			["HR.EMPLOYEES@TEST.DEV2"],
			"SCOTT"
		);
		expect(result.valid).toBe(true);
	});

	test("database link references do not match local allowlist entries", () => {
		const result = validateQuery(
			"SELECT * FROM employees@test.dev2",
			["EMPLOYEES"],
			"HR"
		);
		expect(result.valid).toBe(false);
	});
});
