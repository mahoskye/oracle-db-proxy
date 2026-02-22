import oracledb from "oracledb";
import type { ResolvedEnvironment } from "./config";

type PoolEntry = {
	pool: oracledb.Pool;
	signature: string;
};

const pools = new Map<string, PoolEntry>();

function poolSignature(env: ResolvedEnvironment): string {
	// Includes credentials so password rotation can refresh the pool.
	return [
		env.username,
		env.password,
		env.hostname,
		env.port,
		env.service,
	].join("|");
}

async function getPool(name: string, env: ResolvedEnvironment): Promise<oracledb.Pool> {
	const signature = poolSignature(env);
	const existing = pools.get(name);
	if (existing) {
		if (existing.signature === signature) {
			return existing.pool;
		}
	}

	const pool = await oracledb.createPool({
		user: env.username,
		password: env.password,
		connectString: `${env.hostname}:${env.port}/${env.service}`,
		poolMin: 1,
		poolMax: 3,
		poolIncrement: 1,
	});

	pools.set(name, { pool, signature });

	if (existing) {
		// Drain and close the old pool in the background so in-flight requests can complete.
		void existing.pool.close(10)
			.then(() => {
				console.error(`Closed previous connection pool for environment "${name}" after config or credential change`);
			})
			.catch((error) => {
				console.error(`Failed to close previous connection pool for environment "${name}": ${error}`);
			});
	}

	return pool;
}

/**
 * Returns an Oracle connection from the pool for the given environment,
 * creating the pool lazily on first use. Sets `callTimeout` from config.
 */
export async function getConnection(
	name: string,
	env: ResolvedEnvironment
): Promise<oracledb.Connection> {
	const pool = await getPool(name, env);
	const connection = await pool.getConnection();
	connection.callTimeout = env.timeout_seconds * 1000;
	return connection;
}

/** Drains and closes all Oracle connection pools. Called during graceful shutdown. */
export async function closeAllPools(): Promise<void> {
	const entries = [...pools.entries()];
	pools.clear();

	await Promise.all(entries.map(async ([name, { pool }]) => {
		try {
			await pool.close(0);
			console.error(`Closed connection pool for environment "${name}"`);
		}
		catch (error) {
			console.error(`Failed to close connection pool for environment "${name}": ${error}`);
		}
	}));
}
