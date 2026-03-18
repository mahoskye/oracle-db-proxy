import { z } from "zod";
import { loadConfig, resolveEnvironment } from "../config";
import { executeQuery } from "../executor";

export const runQuerySchema = {
	environment: z.string().trim().min(1).describe("Named environment from config (e.g. 'dev', 'test', 'prod')"),
	sql: z.string().trim().min(1).describe("A SELECT statement to execute. No writes, DDL, procedure execution permitted."),
};

/** MCP handler for `run_query`. Loads config, resolves the environment, and delegates to `executeQuery`. */
export async function runQueryHandler(
	{environment, sql}: {environment: string, sql: string}
){
	try {
		const config = loadConfig();
		const env = resolveEnvironment(config, environment);
		const result = await executeQuery(environment, env, sql);
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify(result, null, 2),
			}],
		};
	} catch(e) {
		const message = e instanceof Error ? e.message : String(e);
		return {
			content: [{
				type: "text" as const,
				text: JSON.stringify({ error: "EXECUTION_ERROR", message, environment }, null, 2),
			}],
		};
	}
}
