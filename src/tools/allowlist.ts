export function splitIdentifierTokens(raw: string): string[] {
	return (raw.match(/"([^"]|"")*"|[^.]+/g) ?? [])
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

export function splitIdentifierParts(raw: string): string[] {
	return splitIdentifierTokens(raw)
		.map((part) => {
			if (part.startsWith("\"") && part.endsWith("\"") && part.length >= 2) {
				return part.slice(1, -1).replace(/""/g, "\"");
			}
			return part.toUpperCase();
		});
}

export function normalizeIdentifier(raw: string): string {
	const { objectRaw, dblinkRaw } = splitAtDatabaseLink(raw);
	const normalizedObject = splitIdentifierParts(objectRaw).join(".");
	const normalizedDbLink = dblinkRaw ? splitIdentifierParts(dblinkRaw).join(".") : "";

	if (!normalizedDbLink) {
		return normalizedObject;
	}

	return `${normalizedObject}@${normalizedDbLink}`;
}

type IdentifierReference = {
	owner?: string;
	table: string;
	dblink?: string;
	full: string;
};

function splitAtDatabaseLink(raw: string): { objectRaw: string; dblinkRaw?: string } {
	let inQuotes = false;

	for (let i = 0; i < raw.length; i++) {
		const char = raw[i];
		if (char === "\"") {
			if (inQuotes && raw[i + 1] === "\"") {
				i++;
				continue;
			}
			inQuotes = !inQuotes;
			continue;
		}
		if (!inQuotes && char === "@") {
			return {
				objectRaw: raw.slice(0, i),
				dblinkRaw: raw.slice(i + 1),
			};
		}
	}

	return { objectRaw: raw };
}

export function parseIdentifierReference(raw: string): IdentifierReference | null {
	const { objectRaw, dblinkRaw } = splitAtDatabaseLink(raw);
	const objectParts = splitIdentifierParts(objectRaw);
	if (objectParts.length === 0) {
		return null;
	}

	const table = objectParts[objectParts.length - 1];
	if (!table) {
		return null;
	}

	const owner = objectParts.length > 1 ? objectParts.slice(0, -1).join(".") : undefined;
	const dblink = dblinkRaw ? splitIdentifierParts(dblinkRaw).join(".") : undefined;
	const fullObject = owner ? `${owner}.${table}` : table;

	return {
		owner,
		table,
		dblink,
		full: dblink ? `${fullObject}@${dblink}` : fullObject,
	};
}

export function parseIdentifierTokensReference(raw: string): IdentifierReference | null {
	const { objectRaw, dblinkRaw } = splitAtDatabaseLink(raw);
	const objectParts = splitIdentifierTokens(objectRaw);
	if (objectParts.length === 0) {
		return null;
	}

	const table = objectParts[objectParts.length - 1];
	if (!table) {
		return null;
	}

	const owner = objectParts.length > 1 ? objectParts.slice(0, -1).join(".") : undefined;
	const dblink = dblinkRaw?.trim() || undefined;

	return {
		owner,
		table,
		dblink,
		full: normalizeIdentifier(raw),
	};
}

function splitQualifiedName(name: string): { owner?: string; table: string } {
	const dot = name.lastIndexOf(".");
	if (dot === -1) {
		return { table: name };
	}

	return {
		owner: name.slice(0, dot),
		table: name.slice(dot + 1),
	};
}

export function isTableAllowed(
	allowlist: string[],
	table: string,
	owner?: string,
	defaultOwner?: string,
	dblink?: string
): boolean {
	const allowlistSet = new Set(allowlist.map(normalizeIdentifier).filter((entry) => entry.length > 0));
	const normalizedTable = normalizeIdentifier(table);
	const normalizedOwner = owner ? normalizeIdentifier(owner) : "";
	const normalizedDefaultOwner = defaultOwner ? normalizeIdentifier(defaultOwner) : "";
	const normalizedDbLink = dblink ? normalizeIdentifier(dblink) : "";
	const normalizedTableWithLink = normalizedDbLink ? `${normalizedTable}@${normalizedDbLink}` : normalizedTable;
	const normalizedQualifiedWithLink = normalizedOwner
		? `${normalizedOwner}.${normalizedTableWithLink}`
		: normalizedTableWithLink;

	// Exact qualified match always wins.
	if (allowlistSet.has(normalizedQualifiedWithLink)) {
		return true;
	}

	// For owned references, unqualified allowlist entries are only valid in the default schema.
	if (normalizedOwner) {
		return normalizedOwner === normalizedDefaultOwner && allowlistSet.has(normalizedTableWithLink);
	}

	// For unowned references, direct short-name match is valid.
	if (allowlistSet.has(normalizedTableWithLink)) {
		return true;
	}

	// For unowned references, allow a qualified allowlist entry in the default schema.
	if (!normalizedDefaultOwner) {
		return false;
	}

	for (const entry of allowlistSet) {
		const parsed = parseIdentifierReference(entry);
		if (
			parsed &&
			parsed.owner === normalizedDefaultOwner &&
			parsed.table === normalizedTable &&
			(parsed.dblink ?? "") === normalizedDbLink
		) {
			return true;
		}
	}

	return false;
}
