import { join } from "path";

/**
 * Returns the platform-specific configuration directory path.
 * Uses `%APPDATA%\oracle-db-proxy` on Windows, `~/.oracle-db-proxy` elsewhere.
 */
function getConfigDir(): string {
	if(process.platform === "win32"){
		const appData = process.env.APPDATA;
		if(!appData) throw new Error("APPDATA environment variable is not set.");
		return join(appData, "oracle-db-proxy");
	}

	const home = process.env.HOME;
	if(!home) throw new Error(`HOME environment variable is not set.`);
	return join(home, ".oracle-db-proxy");
}

/** Absolute path to the configuration directory. */
export const CONFIG_DIR = getConfigDir();
/** Absolute path to `config.yaml`. */
export const CONFIG_PATH = join(CONFIG_DIR, "config.yaml");
/** Absolute path to the SQLite audit database. */
export const AUDIT_DB_PATH = join(CONFIG_DIR, "audit.db");
