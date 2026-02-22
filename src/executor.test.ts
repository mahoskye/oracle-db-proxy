import { describe, expect, test } from "bun:test";
import { isResultTruncated, normalizeSqlInput } from "./executor";

describe("isResultTruncated", () => {
	test("returns false when total rows are exactly at the limit", () => {
		expect(isResultTruncated(1000, 1000)).toBe(false);
	});

	test("returns true when total rows exceed the limit", () => {
		expect(isResultTruncated(1001, 1000)).toBe(true);
	});

	test("returns false when total rows are below the limit", () => {
		expect(isResultTruncated(500, 1000)).toBe(false);
	});
});

describe("normalizeSqlInput", () => {
	test("strips trailing semicolons and surrounding whitespace", () => {
		expect(normalizeSqlInput("  SELECT 1 FROM dual;  ")).toBe("SELECT 1 FROM dual");
		expect(normalizeSqlInput("SELECT 1 FROM dual;;;")).toBe("SELECT 1 FROM dual");
	});

	test("does not alter internal semicolons inside literals", () => {
		expect(normalizeSqlInput("SELECT ';' AS x FROM dual;")).toBe("SELECT ';' AS x FROM dual");
	});
});
