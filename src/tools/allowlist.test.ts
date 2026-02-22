import { describe, expect, test } from "bun:test";
import { isTableAllowed } from "./allowlist";

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
});
