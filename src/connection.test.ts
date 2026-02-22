import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import oracledb from "oracledb";
import type { ResolvedEnvironment } from "./config";
import { closeAllPools, getConnection } from "./connection";

type OracleLike = {
	createPool: (...args: unknown[]) => Promise<{
		getConnection: () => Promise<{ callTimeout: number; close: () => Promise<void> }>;
		close: (drainTime: number) => Promise<void>;
	}>;
};

const oracle = oracledb as unknown as OracleLike;
const originalCreatePool = oracle.createPool;
const originalConsoleError = console.error;

const BASE_ENV: ResolvedEnvironment = {
	hostname: "db.example.com",
	port: 1521,
	service: "DEV",
	allowlist_enabled: false,
	allowed_tables: [],
	timeout_seconds: 30,
	max_rows: 1000,
	username: "app_user",
	password: "secret",
};

beforeEach(async () => {
	console.error = () => {};
	await closeAllPools();
});

afterEach(async () => {
	oracle.createPool = originalCreatePool;
	await closeAllPools();
	console.error = originalConsoleError;
});

describe("connection pool lifecycle", () => {
	test("reuses the existing pool when environment signature is unchanged", async () => {
		let createPoolCalls = 0;
		oracle.createPool = async () => {
			createPoolCalls += 1;
			const connection = {
				callTimeout: 0,
				close: async () => {},
			};

			return {
				getConnection: async () => connection,
				close: async () => {},
			};
		};

		const conn1 = await getConnection("dev", BASE_ENV);
		const conn2 = await getConnection("dev", BASE_ENV);

		expect(createPoolCalls).toBe(1);
		expect(conn1.callTimeout).toBe(30000);
		expect(conn2.callTimeout).toBe(30000);
	});

	test("recreates the pool and drains the previous pool when config changes", async () => {
		let poolNumber = 0;
		const closeCalls: Array<{ pool: number; drainTime: number }> = [];

		oracle.createPool = async () => {
			poolNumber += 1;
			const currentPool = poolNumber;
			const connection = {
				callTimeout: 0,
				close: async () => {},
			};

			return {
				getConnection: async () => connection,
				close: async (drainTime: number) => {
					closeCalls.push({ pool: currentPool, drainTime });
				},
			};
		};

		await getConnection("dev", BASE_ENV);
		await getConnection("dev", { ...BASE_ENV, password: "rotated-secret" });
		await Bun.sleep(0);

		expect(poolNumber).toBe(2);
		expect(closeCalls).toContainEqual({ pool: 1, drainTime: 10 });
	});

	test("closeAllPools continues closing remaining pools when one close throws", async () => {
		let poolNumber = 0;
		const closeCalls: Array<{ pool: number; drainTime: number }> = [];

		oracle.createPool = async () => {
			poolNumber += 1;
			const currentPool = poolNumber;
			const connection = {
				callTimeout: 0,
				close: async () => {},
			};

			return {
				getConnection: async () => connection,
				close: async (drainTime: number) => {
					closeCalls.push({ pool: currentPool, drainTime });
					if (currentPool === 1 && drainTime === 0) {
						throw new Error("simulated close failure");
					}
				},
			};
		};

		await getConnection("dev", BASE_ENV);
		await getConnection("test", { ...BASE_ENV, service: "TEST" });

		await expect(closeAllPools()).resolves.toBeUndefined();

		expect(closeCalls).toContainEqual({ pool: 1, drainTime: 0 });
		expect(closeCalls).toContainEqual({ pool: 2, drainTime: 0 });
	});
});
