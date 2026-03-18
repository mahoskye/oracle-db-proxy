import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runQuerySchema, runQueryHandler } from "./tools/run_query";
import { listTablesSchema, listTablesHandler} from "./tools/list_tables";
import { getTableSchemaSchema, getTableSchemaHandler } from "./tools/get_table_schema";

/** Creates and returns the MCP server with all three tools registered. */
export function createServer(): McpServer {
	const server = new McpServer({
		name: "oracle-db-proxy",
		version: "1.0.0",
	});

	server.tool(
		"run_query",
		"Executes a read-only SELECT query against the specified database environment. Use this to retrieve data, inspect records, or investigate table contents. The query must be a SELECT statement — no writes, DDL, or procedure execution is permitted. If results exceed the row limit, a warning is included with the total row count. To paginate large results, use Oracle OFFSET/FETCH NEXT syntax in your query.",
		runQuerySchema,
		runQueryHandler
   	);

	server.tool(
		"list_tables",
		"Lists local tables and views accessible in the specified environment. Optionally filter by schema. This tool does not browse remote catalogs over database links. Use this to orient yourself before writing a query — do not guess table names.",
		listTablesSchema,
		listTablesHandler
	);

	server.tool(
	    "get_table_schema",
	    "Returns column definitions for a specific table or view — column names, data types, nullability, and comments. Supports explicit remote objects via TABLE@DBLINK or SCHEMA.TABLE@DBLINK. Use this before querying a table you are unfamiliar with.",
	    getTableSchemaSchema,
	    getTableSchemaHandler
	);

	return server;
}
