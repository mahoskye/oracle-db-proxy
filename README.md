# oracle-db-proxy

A read-only Oracle database proxy exposed as an MCP (Model Context Protocol) server. It allows AI agents to query Oracle databases without data modification risk. All safety enforcement is handled at the application layer via SQL parse-tree analysis, with no database-level permission changes required.

## Features

- Read-only enforcement via SQL parsing, so no writes, DDL, or procedure execution can reach the database
- Three MCP tools: `run_query`, `list_tables`, `get_table_schema`
- Multiple named environments (dev, test, prod) from a single config file
- Per-environment table allowlists
- Row limits with total count reporting when limits are hit
- Query timeout enforcement
- SQLite audit log of all query activity
- Shared config directory, so any MCP-compatible agent on the machine can use the same setup

## Requirements

- [Bun](https://bun.sh) (latest stable)
- Oracle Instant Client (required by `oracledb`), see [Oracle's installation guide](https://oracle.github.io/node-oracledb/INSTALL.html)

## Installation

```bash
git clone https://github.com/mahoskye/oracle-db-proxy
cd oracle-db-proxy
bun install
```

## First Run

Run the server once to initialize the config directory:

```bash
bun src/index.ts
```

On first run the server will:

1. Create `~/.oracle-db-proxy/` (Linux/macOS) or `%APPDATA%\oracle-db-proxy\` (Windows)
2. Write a template `config.yaml` with placeholder values
3. Create `audit.db` and ensure the `query_log` schema exists
4. Exit with a message telling you to fill in the config

Edit the generated config file before running again.

## Configuration

The config file lives at:

- **Linux/macOS:** `~/.oracle-db-proxy/config.yaml`
- **Windows:** `%APPDATA%\oracle-db-proxy\config.yaml`

```yaml
# oracle-db-proxy configuration
# Passwords must be set as environment variables, not in this file.

credentials:
  username: usgs
  password_env: ORACLE_DB_PASSWORD
  # Set the variable name here, then set the actual password
  # in your shell or in your MCP client's env block.

defaults:
  timeout_seconds: 30
  max_rows: 1000

environments:
  dev:
    hostname: your-dev-host.example.com
    port: 1521
    service: DEV.SERVICE
    allowlist_enabled: false

  test:
    hostname: your-test-host.example.com
    port: 1521
    service: TEST.SERVICE
    allowlist_enabled: false

  prod:
    hostname: your-prod-host.example.com
    port: 1521
    service: PROD.SERVICE
    allowlist_enabled: true
    allowed_tables:
      - SAMPLE
      - RESULT
```

### Passwords

Passwords are never stored in the config file. Set them as environment variables:

```bash
# Linux/macOS
export ORACLE_DB_PASSWORD=yourpassword

# Windows (PowerShell)
$env:ORACLE_DB_PASSWORD = "yourpassword"
```

### Per-Environment Credential Overrides

If different environments use different credentials, add a `credentials` block under the environment:

```yaml
environments:
  prod:
    hostname: prod-host.example.com
    port: 1521
    service: PROD.SERVICE
    allowlist_enabled: true
    credentials:
      username: prod_user
      password_env: ORACLE_DB_PASSWORD_PROD
```

### Table Allowlists

When `allowlist_enabled: true`, only tables listed under `allowed_tables` can be queried via `run_query`.
`list_tables` is filtered down to allowlisted objects, and `get_table_schema` denies access to non-allowlisted tables.
The agent receives clear rejection messages with enough detail to correct and retry.
Use `SCHEMA.TABLE` entries when you need cross-schema access. Unqualified entries apply to the connected user's default schema. Use `TABLE@DBLINK` or `SCHEMA.TABLE@DBLINK` when you need to allow remote objects over Oracle database links.

When `allowlist_enabled: false`, any table accessible to the database user can be queried.

## Starting the Server

```bash
ORACLE_DB_PASSWORD=yourpassword bun src/index.ts
```

You should see:

```
oracle-db-proxy running on stdio
```

The server communicates over stdio and is ready to accept MCP connections.

## Connecting an Agent

The server uses stdio transport. Your MCP client spawns it as a process and communicates over stdin/stdout. Configure your agent with the path to the entry point and the password environment variable.

### Generic MCP Client Config

Most MCP-compatible clients accept a configuration block in this format:

```json
{
  "command": "bun",
  "args": ["/path/to/oracle-db-proxy/src/index.ts"],
  "env": {
    "ORACLE_DB_PASSWORD": "yourpassword"
  }
}
```

### Goose

Add to your Goose MCP config:

```yaml
extensions:
  oracle-db-proxy:
    type: stdio
    cmd: bun
    args:
      - /path/to/oracle-db-proxy/src/index.ts
    env:
      ORACLE_DB_PASSWORD: yourpassword
```

### Amp

Add to your `amp.toml`:

```toml
[[mcp]]
name = "oracle-db-proxy"
command = "bun"
args = ["/path/to/oracle-db-proxy/src/index.ts"]

[mcp.env]
ORACLE_DB_PASSWORD = "yourpassword"
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "oracle-db-proxy": {
      "command": "bun",
      "args": ["/path/to/oracle-db-proxy/src/index.ts"],
      "env": {
        "ORACLE_DB_PASSWORD": "yourpassword"
      }
    }
  }
}
```

## Available Tools

### `run_query`

Executes a read-only SELECT query against the specified environment.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `environment` | string | Yes | Named environment from config |
| `sql` | string | Yes | A SELECT statement to execute |

Returns rows as an array of objects. If results are truncated by the row limit, a warning is included with the total row count so the agent can refine its query.

Use this after you know the object names you need. If the table is unfamiliar, call `get_table_schema` first.

### `list_tables`

Lists local tables and views accessible in the specified environment.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `environment` | string | Yes | Named environment from config |
| `schema` | string | No | Schema/owner to filter by. Defaults to the connected user's schema |

This tool only lists local objects visible through the current Oracle connection. It does not browse remote catalogs over database links.

Use this first when exploring a local environment and you do not yet know the correct table or view name.

### `get_table_schema`

Returns column definitions for a specific table or view.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `environment` | string | Yes | Named environment from config |
| `table` | string | Yes | Table or view name. Supports `TABLE`, `SCHEMA.TABLE`, `TABLE@DBLINK`, or `SCHEMA.TABLE@DBLINK` |
| `schema` | string | No | Schema/owner. Defaults to the connected user's schema |

This tool can inspect explicitly named remote objects over Oracle database links when the database link is included in `table`. The `schema` parameter must not include a database link.

Examples:

- Local default schema: `table: "EMPLOYEES"`
- Local explicit schema: `table: "EMPLOYEES", schema: "HR"` or `table: "HR.EMPLOYEES"`
- Remote default schema: `table: "EMPLOYEES@TEST.DEV2"`
- Remote explicit schema: `table: "HR.EMPLOYEES@TEST.DEV2"`

If allowlists are enabled and the requested object is not allowlisted, this tool returns:

```json
{
  "error": "ACCESS_DENIED",
  "message": "Table OWNER.TABLE is not in the allowlist for this environment.",
  "owner": "OWNER",
  "table": "TABLE",
  "dblink": null
}
```

## Recommended Workflow

For best results, agents should usually follow this sequence:

1. Use `list_tables` to discover local object names when the schema is not known.
2. Use `get_table_schema` before querying an unfamiliar table or view.
3. Use `run_query` only after the object name and columns are known.

For remote objects over Oracle database links, skip `list_tables` and call `get_table_schema` directly with an explicit `TABLE@DBLINK` or `SCHEMA.TABLE@DBLINK` reference.

## Security Model

All safety enforcement happens in the application layer. No database user configuration is required.

Every query submitted to `run_query` passes through a validation pipeline before touching the database:

1. **Parse**: SQL is parsed with `@griffithswaite/ts-plsql-parser` (Oracle PL/SQL grammar). Unparseable input is rejected.
2. **Single statement**: multiple semicolon-separated statements are rejected.
3. **SELECT only**: the root statement must be a SELECT.
4. **Tree walk**: every node in the full parse tree is inspected. Any INSERT, UPDATE, DELETE, MERGE, CREATE, DROP, ALTER, TRUNCATE, EXEC, CALL, or `FOR UPDATE` row-locking clause is rejected, including those hidden inside CTEs.
5. **Allowlist**: if enabled for the environment, all table references are checked against the allowlist, including schema-qualified and database-link references such as `SCHEMA.TABLE@DBLINK`.

Rejection messages are returned with specific details so the agent can correct and retry.

## Audit Log

All `run_query` calls are logged to a SQLite database at:

- **Linux/macOS:** `~/.oracle-db-proxy/audit.db`
- **Windows:** `%APPDATA%\oracle-db-proxy\audit.db`

The `query_log` table records timestamp, environment, status, SQL hash, full SQL text, rejection reason, row count, execution time, and whether results were truncated. All agents on the machine share the same audit log.

## Project Structure

```
src/
  index.ts              # Entry point
  server.ts             # MCP server and tool registration
  config.ts             # Config loading and validation
  init.ts               # First-run initialization
  paths.ts              # Cross-platform config directory resolution
  validator.ts          # SQL safety validation
  executor.ts           # Query execution and result shaping
  connection.ts         # Oracle connection pool management
  audit.ts              # SQLite audit logging
  tools/
    run_query.ts
    list_tables.ts
    get_table_schema.ts
```

## License

MIT
