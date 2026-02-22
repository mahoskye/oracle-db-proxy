import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runInit } from "./init";
import { createServer } from "./server";
import { closeAllPools } from "./connection";

async function main(): Promise<void> {
	// Run init checks before anything else
	runInit();

	const server = createServer();
	const transport = new StdioServerTransport();

	// Graceful shutdown
	process.on("SIGINT", async () => {
		await closeAllPools();
		process.exit(0);
	});

	process.on("SIGTERM", async () => {
		await closeAllPools();
		process.exit(0);
	});

	await server.connect(transport);
	console.error("oracle-db-proxy running on stdio");
}

main().catch((e) => {
	console.error("Fatal error: ", e);
	process.exit(1);
});