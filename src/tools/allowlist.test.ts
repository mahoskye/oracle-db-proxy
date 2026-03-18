import { describe, expect, test } from "bun:test";
import { isTableAllowed, normalizeIdentifier, parseIdentifierReference } from "./allowlist";

describe("isTableAllowed", () => {
	test("matches unqualified table names case-insensitively", () => {
		expect(isTableAllowed(["employees"], "EMPLOYEES")).toBe(true);
		expect(isTableAllowed(["EMPLOYEES"], "employees")).toBe(true);
	});

	test("does not allow cross-schema match for unqualified allowlist entries", () => {
		expect(isTableAllowed(["EMPLOYEES"], "EMPLOYEES", "HR", "SCOTT")).toBe(false);
		expect(isTableAllowed(["EMPLOYEES"], "EMPLOYEES", "HR", "HR")).toBe(true);
	});

	test("matches schema-qualified allowlist entries", () => {
		expect(isTableAllowed(["HR.EMPLOYEES"], "EMPLOYEES", "HR", "SCOTT")).toBe(true);
		expect(isTableAllowed(["HR.EMPLOYEES"], "EMPLOYEES", "SCOTT", "HR")).toBe(false);
	});

	test("supports quoted identifiers", () => {
		expect(isTableAllowed(['"Hr"."Employees"'], '"Employees"', '"Hr"', "SCOTT")).toBe(true);
		expect(isTableAllowed(['"Hr"."Employees"'], '"Employees"', '"Other"', "HR")).toBe(false);
	});

	test("preserves case for quoted identifiers", () => {
		expect(isTableAllowed(['"Hr"."Employees"'], '"Employees"', '"Hr"', "SCOTT")).toBe(true);
		expect(isTableAllowed(['"Hr"."Employees"'], '"EMPLOYEES"', '"Hr"', "SCOTT")).toBe(false);
	});

	test("supports database link references", () => {
		expect(isTableAllowed(["EMPLOYEES@TEST.DEV2"], "EMPLOYEES", undefined, "HR", "TEST.DEV2")).toBe(true);
		expect(isTableAllowed(["HR.EMPLOYEES@TEST.DEV2"], "EMPLOYEES", "HR", "SCOTT", "TEST.DEV2")).toBe(true);
		expect(isTableAllowed(["EMPLOYEES"], "EMPLOYEES", undefined, "HR", "TEST.DEV2")).toBe(false);
	});

	test("normalizes database link references", () => {
		expect(normalizeIdentifier("employees@test.dev2")).toBe("EMPLOYEES@TEST.DEV2");
		expect(normalizeIdentifier('\"Hr\".\"Employees\"@test.dev2')).toBe("Hr.Employees@TEST.DEV2");
	});

	test("parses owner, table, and database link components", () => {
		expect(parseIdentifierReference("hr.employees@test.dev2")).toEqual({
			owner: "HR",
			table: "EMPLOYEES",
			dblink: "TEST.DEV2",
			full: "HR.EMPLOYEES@TEST.DEV2",
		});
		expect(parseIdentifierReference("employees@test.dev2")).toEqual({
			owner: undefined,
			table: "EMPLOYEES",
			dblink: "TEST.DEV2",
			full: "EMPLOYEES@TEST.DEV2",
		});
	});
});
