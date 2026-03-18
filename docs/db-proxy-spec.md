# Read-Only Database MCP Proxy - Project Specification

## Overview

A read-only database proxy exposed as an MCP (Model Context Protocol) server, built with Bun and TypeScript. It allows AI agents operating in TUI environments to safely query Oracle databases without any risk of data modification. All safety enforcement is done at the application layer. The server communicates over stdio transport and is configured from a shared directory in the user's home folder, making it accessible to any MCP-compatible agent on the machine.

---

## Project Goals

- Give AI agents structured, safe read access to Oracle databases
- Enforce read-only access in the application layer via SQL parse-tree analysis
- Support multiple named environments (dev, test, prod) from a single config
- Log all query activity to a shared audit database
- Be simple enough to initialize and use with minimal setup

---

## Runtime & Language

- **Runtime:** Bun (latest stable)
- **Language:** TypeScript (strict mode)
- **Key dependencies:**
  - `@modelcontextprotocol/sdk` - MCP server scaffolding
  - `oracledb` - Oracle database connectivity (official Oracle npm package)
  - `@griffithswaite/ts-plsql-parser` - Oracle PL/SQL parse-tree validation
  - `zod` - Tool parameter schema validation and description
  - `js-yaml` - YAML config parsing
  - `bun:sqlite` - Audit database (SQLite)

---

## Directory Structure

```
project root/
  src/
    index.ts              # Entry point - init check, then start MCP server
    server.ts             # MCP server definition and tool registration
    config.ts             # Config loading and validation
    init.ts               # First-run initialization routine
    validator.ts          # SQL safety validation via parse-tree analysis
    executor.ts           # Query execution, pagination, result shaping
    connection.ts         # Oracle connection pool management
    audit.ts              # SQLite audit log read/write
    tools/
      run_query.ts        # run_query tool implementation
      list_tables.ts      # list_tables tool implementation
      get_table_schema.ts # get_table_schema tool implementation
  package.json
  tsconfig.json
  README.md
```

---

## Home Directory Layout

On first run, the server creates the following structure if it does not exist:

```
~/.oracle-db-proxy/
  config.yaml    # Created from template on first run with placeholder values
  audit.db       # SQLite database, schema initialized on first run
```

All agents on the machine that point to this MCP server share this config and audit database.

### First-Run Behavior

On startup, `init.ts` runs before anything else:

1. Check if `~/.oracle-db-proxy/` exists. If not, create it.
2. Check if `~/.oracle-db-proxy/config.yaml` exists. If not, write the template config (see Config section).
3. Ensure `~/.oracle-db-proxy/audit.db` exists and run schema migration (`CREATE TABLE IF NOT EXISTS ...`) so the audit schema is always present.
4. Parse and validate the config. If any environment still contains placeholder values (e.g. `hostname: CHANGE_ME`), exit with a clear error message explaining which fields need to be filled in and where the config file is located.
5. If all checks pass, proceed to start the MCP server.

---

## Configuration

### File: `~/.oracle-db-proxy/config.yaml`

```yaml
# oracle-db-proxy configuration
# Edit this file before starting the server.
# Passwords must be set as environment variables, not in this file.

credentials:
  username: usgs
  # Set the ORACLE_DB_PASSWORD environment variable before running.
  # Per-environment overrides can be added under each environment block.
  password_env: ORACLE_DB_PASSWORD

defaults:
  timeout_seconds: 30
  max_rows: 1000

environments:
  dev:
    hostname: CHANGE_ME
    port: 1521
    service: CHANGE_ME
    allowlist_enabled: false
    # allowed_tables:
    #   - SAMPLE
    #   - RESULT

  test:
    hostname: CHANGE_ME
    port: 1521
    service: CHANGE_ME
    allowlist_enabled: false

  prod:
    hostname: CHANGE_ME
    port: 1521
    service: CHANGE_ME
    allowlist_enabled: true
    allowed_tables: []
    # Override credentials for this environment if needed:
    # credentials:
    #   username: usgs_prod
    #   password_env: ORACLE_DB_PASSWORD_PROD
```

### Config Schema (TypeScript / Zod)

```typescript
const CredentialsSchema = z.object({
  username: z.string().min(1),
  password_env: z.string().min(1),
}).strict();

const EnvironmentSchema = z.object({
  hostname: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(1521),
  service: z.string().min(1),
  allowlist_enabled: z.boolean().default(false),
  allowed_tables: z.array(z.string().min(1)).optional(),
  timeout_seconds: z.number().int().positive().optional(),
  max_rows: z.number().int().positive().optional(),
  credentials: CredentialsSchema.optional(), // overrides top-level credentials
}).strict();

const ConfigSchema = z.object({
  credentials: CredentialsSchema,
  defaults: z.object({
    timeout_seconds: z.number().int().positive().default(30),
    max_rows: z.number().int().positive().default(1000),
  }).strict(),
  environments: z.record(z.string(), EnvironmentSchema),
}).strict();
```

Effective limits for a given environment are resolved by merging `defaults` with any environment-level overrides.

---

## MCP Server

### Transport

Stdio (`StdioServerTransport`). The server is spawned by the agent and communicates over stdin/stdout. No HTTP server is involved.

### Agent Configuration Example

Most TUI MCP clients accept a config block like this:

```json
{
  "command": "bun",
  "args": ["/path/to/project/src/index.ts"],
  "env": {
    "ORACLE_DB_PASSWORD": "your-password-here"
  }
}
```

### Server Identity

```typescript
const server = new McpServer({
  name: "oracle-db-proxy",
  version: "1.0.0",
});
```

---

## MCP Tools

### 1. `run_query`

**Description (shown to agent):**
> Executes a read-only SELECT query against the specified database environment. Use this to retrieve data, inspect records, or investigate table contents. The query must be a SELECT statement - no writes, DDL, or procedure execution is permitted. Returns rows as an array of objects. If results exceed the row limit, a warning is included with the total row count. To paginate large results, use Oracle OFFSET/FETCH NEXT syntax in your query.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `environment` | `string` | Yes | Named environment from config (e.g. "dev", "test", "prod") |
| `sql` | `string` | Yes | A SELECT statement to execute |

**Behavior:**

1. Validate `environment` exists in config
2. Pass `sql` through the safety validator (see Validation section)
3. If validation fails, return a detailed rejection message - do not execute
4. Resolve effective `max_rows` for the environment
5. Wrap the validated query in a ROWNUM limit: `SELECT * FROM (<original_sql>) WHERE ROWNUM <= :maxRows`
6. Execute with the environment's configured timeout
7. Return results with metadata

**Success response shape:**

```json
{
  "rows": [...],
  "row_count": 42,
  "total_rows": 42,
  "truncated": false,
  "execution_ms": 312
}
```

**Warning response shape (limit hit):**

```json
{
  "rows": [...],
  "row_count": 1000,
  "total_rows": 5432,
  "truncated": true,
  "warning": "Result set has 5432 total rows but is limited to 1000. Refine your WHERE clause to narrow results, or use OFFSET/FETCH NEXT for pagination.",
  "execution_ms": 890
}
```

**Timeout response shape:**

```json
{
  "rows": [],
  "row_count": 0,
  "total_rows": 0,
  "truncated": true,
  "warning": "Query exceeded the time limit of 30 seconds and was cancelled. Consider adding WHERE clauses or filters to narrow the result set.",
  "execution_ms": 30001
}
```

**Rejection response shape:**

```json
{
  "error": "QUERY_REJECTED",
  "reason": "Query contains a write operation (INSERT) inside a CTE. Only pure SELECT statements are permitted.",
  "sql": "WITH cte AS (INSERT INTO ...) SELECT * FROM cte"
}
```

---

### 2. `list_tables`

**Description (shown to agent):**
> Lists all tables and views accessible to the current user in the specified environment. Optionally filter by schema. Use this to orient yourself before writing a query - do not guess table names.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `environment` | `string` | Yes | Named environment from config |
| `schema` | `string` | No | Schema/owner name to filter by. Defaults to the connected user's schema |

**Behavior:**

Executes a hardcoded internal query against `ALL_TABLES` and `ALL_VIEWS`. If an allowlist is enabled for the environment, filters results to only show allowlisted tables. Unqualified allowlist entries apply to the connected user's default schema; use `SCHEMA.TABLE` entries for cross-schema access. Returns table name, owner, type (TABLE or VIEW), and row count estimate from Oracle statistics. This tool is local-only and does not browse remote catalogs over database links.

Use this first when the agent does not yet know the correct local table or view name.

**Response shape:**

```json
{
  "tables": [
    { "name": "SAMPLE", "owner": "USGS", "type": "TABLE", "estimated_rows": 145823 },
    { "name": "RESULT", "owner": "USGS", "type": "TABLE", "estimated_rows": 4201044 },
    { "name": "V_SAMPLE_SUMMARY", "owner": "USGS", "type": "VIEW", "estimated_rows": null }
  ],
  "count": 3,
  "schema": "USGS",
  "environment": "dev"
}
```

---

### 3. `get_table_schema`

**Description (shown to agent):**
> Returns the column definitions for a specific table or view - column names, data types, nullability, and any available comments. Use this before querying a table you are unfamiliar with.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `environment` | `string` | Yes | Named environment from config |
| `table` | `string` | Yes | Table or view name. Supports `TABLE`, `SCHEMA.TABLE`, `TABLE@DBLINK`, or `SCHEMA.TABLE@DBLINK` |
| `schema` | `string` | No | Schema/owner name. Defaults to the connected user's schema |

**Behavior:**

Executes hardcoded internal queries against `ALL_TAB_COLUMNS` and `ALL_COL_COMMENTS`. Returns column metadata in ordinal position order. If an allowlist is enabled for the environment, the requested table must be in the allowlist. Unqualified allowlist entries apply to the connected user's default schema; use `SCHEMA.TABLE` entries for cross-schema access. Remote objects are supported only when explicitly named with `TABLE@DBLINK` or `SCHEMA.TABLE@DBLINK`; the `schema` argument must not include a database link.

Use this before querying an unfamiliar table or view. For remote objects, call this directly with an explicit `TABLE@DBLINK` or `SCHEMA.TABLE@DBLINK` reference.

**Response shape:**

```json
{
  "table": "SAMPLE",
  "owner": "USGS",
  "dblink": null,
  "environment": "dev",
  "columns": [
    {
      "name": "SAMPLE_ID",
      "position": 1,
      "data_type": "NUMBER",
      "nullable": false,
      "comment": "Primary key identifier for the sample record"
    },
    {
      "name": "SAMPLE_DATE",
      "position": 2,
      "data_type": "DATE",
      "nullable": true,
      "comment": null
    }
  ]
}
```

If allowlist enforcement blocks access, the response shape is:

```json
{
  "error": "ACCESS_DENIED",
  "message": "Table OWNER.TABLE is not in the allowlist for this environment.",
  "environment": "dev",
  "owner": "OWNER",
  "table": "TABLE",
  "dblink": null
}
```

**Recommended agent workflow:**

1. Use `list_tables` to discover local object names when needed.
2. Use `get_table_schema` before querying an unfamiliar object.
3. Use `run_query` only after the object and columns are known.

For remote objects over Oracle database links, skip `list_tables` and call `get_table_schema` directly with an explicit remote reference.

---

## SQL Safety Validation

All SQL submitted to `run_query` passes through `validator.ts` before execution. This is the security-critical component and must fail closed - if validation cannot confirm a query is safe, it rejects it.

### Validation Pipeline

Every query passes through these steps in order. Failure at any step immediately returns a rejection with a specific reason.

**Step 1 - Parse**
Parse the SQL string using `@griffithswaite/ts-plsql-parser` (Oracle grammar). If parsing fails entirely, reject with: `"Query could not be parsed. Ensure it is valid SQL."` Do not attempt heuristic analysis on unparseable input.

**Step 2 - Statement count**
The parsed script must contain exactly one statement. Reject multiple statements (semicolon-separated) with: `"Multiple statements are not permitted. Submit one SELECT at a time"`

**Step 3 - Root statement type**
The root statement must be `SELECT`. Reject anything else with the specific type identified: `"Statement type INSERT is not permitted. Only SELECT statements are allowed."`

**Step 4 - Parse-tree walk for write operations**
Recursively walk every node in the parse tree. If any node represents a write operation - `INSERT`, `UPDATE`, `DELETE`, or `MERGE` - reject with the node type and its parse-tree location: `"Query contains a write operation (INSERT) at root.children[0].children[0]"`

**Step 5 - DDL check**
Reject any node representing DDL: `CREATE`, `DROP`, `ALTER`, `TRUNCATE`, `RENAME`. Rejection reason identifies the DDL type found.

**Step 6 - Execution check**
Reject any node representing procedural execution: `EXEC`, `EXECUTE`, `CALL`, or `BEGIN...END` blocks. Also reject row-locking `FOR UPDATE` clauses.

**Step 7 - Allowlist check (if enabled for environment)**
Extract all table references from the parse tree. If any referenced table is not in the environment's `allowed_tables` list, reject with: `"Query references table FORBIDDEN_TABLE which is not in the allowlist for this environment. Allowed tables: SAMPLE, RESULT."` Unqualified allowlist entries apply to the connected user's default schema; use `SCHEMA.TABLE` entries for cross-schema access. Database link references such as `TABLE@DBLINK` and `SCHEMA.TABLE@DBLINK` must match allowlist entries explicitly.

### Failure Mode

If the parser itself throws an unexpected error or behaves inconsistently, the validator must default to rejection. It must never silently pass a query it could not fully analyze.

---

## Connection Management

`connection.ts` manages Oracle connection pools per environment.

- One connection pool per environment, created lazily on first use
- Pool is reused across subsequent calls to the same environment
- If environment config or credentials change, a fresh pool is created and the previous pool is drained/closed in the background
- Pool settings: minimum 1 connection, maximum 3 connections (sufficient for single-agent use)
- Timeout is enforced at the connection level using `oracledb`'s `callTimeout` property, set to the environment's `timeout_seconds` value in milliseconds
- Credentials resolved at pool creation time: read `password_env` from the environment config, look up the actual value from `process.env`, throw a descriptive error if not set

---

## Audit Logging

`audit.ts` manages a SQLite database at `~/.oracle-db-proxy/audit.db`.

### Schema

```sql
CREATE TABLE IF NOT EXISTS query_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT NOT NULL,             -- ISO 8601
  environment TEXT NOT NULL,
  status      TEXT NOT NULL,             -- 'executed' | 'rejected' | 'timeout' | 'error'
  sql_hash    TEXT NOT NULL,             -- SHA-256 of the raw SQL string
  sql_text    TEXT NOT NULL,             -- full query text
  rejection_reason TEXT,                 -- populated if status = 'rejected'
  row_count   INTEGER,                   -- populated if status = 'executed'
  execution_ms INTEGER,                  -- wall time in milliseconds
  truncated   INTEGER NOT NULL DEFAULT 0 -- boolean: 1 if row limit was hit
);
```

### Behavior

- Every call to `run_query` is logged, whether it succeeds, is rejected, times out, or errors
- `list_tables` and `get_table_schema` are not logged (internal metadata queries)
- Log writes are fire-and-forget - a failure to write to the audit log must not cause the tool call itself to fail, but should emit a stderr warning

---

## Error Handling Philosophy

- Validation failures are not errors - they are expected outcomes and return structured rejection responses
- Timeout is not an error - it returns a structured warning response with partial or empty results
- Row limit is not an error - it returns results with a warning and `truncated: true`
- Actual errors (DB connection failure, unexpected exception) return a structured error response:

```json
{
  "error": "EXECUTION_ERROR",
  "message": "Could not connect to environment 'prod': TNS timeout. Check that the hostname and service name are correct and that the database is reachable.",
  "environment": "prod"
}
```

Errors are also logged to the audit table with `status = 'error'`.

---

## Row Limiting

The proxy wraps the user's query in a ROWNUM limit to enforce the environment's `max_rows` setting:

```sql
SELECT * FROM (<user_sql>) WHERE ROWNUM <= :maxRows
```

If returned rows reach `max_rows`, a COUNT(*) query runs to determine whether more rows exist. The response sets `truncated: true` only when `total_rows > max_rows`. The agent can use Oracle's `OFFSET/FETCH NEXT` syntax in its own SQL for manual pagination of large result sets.

---

## Security Boundaries

What this proxy guarantees:
- No write operation will reach the database via `run_query`
- No DDL or procedural execution will reach the database
- Queries that cannot be fully parsed and confirmed safe are rejected
- Passwords never appear in config files - only environment variable names
- Row limiting uses bind parameters, not string concatenation

What this proxy does not guarantee:
- Protection against a compromised database user account
- Row-level or field-level data masking
- Network security (assumed to be handled by the environment)
- Protection if the parser has a bug or grammar gap that causes it to misparse a malicious query - this is mitigated by fail-closed behavior

---

## Out of Scope for v1 (Tentative Future Features)

- Support for the LIMS dictionary user / backend schema
- Non-Oracle database support
- Multi-user or HTTP transport mode
- Result caching
- Query plan / EXPLAIN support

---

## Implementation Order

1. Project scaffold - `package.json`, `tsconfig.json`, Bun entry point
2. Config system - YAML loading, Zod validation, environment resolution
3. Init routine - directory creation, template config, SQLite schema
4. SQL validator - parse-tree parsing, all pipeline steps, test cases for evasion attempts
5. Connection manager - Oracle pool setup, credential resolution, timeout wiring
6. Executor - pagination wrapper, query execution, result shaping
7. Audit logger - SQLite writes, fire-and-forget pattern
8. MCP tools - wire all three tools into the server with Zod schemas and descriptions
9. End-to-end test - connect a TUI agent and run sample queries against dev
