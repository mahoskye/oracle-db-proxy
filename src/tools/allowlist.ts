export function normalizeIdentifier(raw: string): string {
	const parts = raw.match(/"([^"]|"")*"|[^.]+/g) ?? [];
	const normalized = parts
		.map((part) => {
			const trimmed = part.trim();
			if (!trimmed) {
				return "";
			}
			if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2) {
				return trimmed.slice(1, -1).replace(/""/g, "\"").toUpperCase();
			}
			return trimmed.toUpperCase();
		})
		.filter((part) => part.length > 0);

	return normalized.join(".");
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
	defaultOwner?: string
): boolean {
	const allowlistSet = new Set(allowlist.map(normalizeIdentifier).filter((entry) => entry.length > 0));
	const normalizedTable = normalizeIdentifier(table);
	const normalizedOwner = owner ? normalizeIdentifier(owner) : "";
	const normalizedDefaultOwner = defaultOwner ? normalizeIdentifier(defaultOwner) : "";

	// Exact qualified match always wins.
	if (normalizedOwner && allowlistSet.has(`${normalizedOwner}.${normalizedTable}`)) {
		return true;
	}

	// For owned references, unqualified allowlist entries are only valid in the default schema.
	if (normalizedOwner) {
		return normalizedOwner === normalizedDefaultOwner && allowlistSet.has(normalizedTable);
	}

	// For unowned references, direct short-name match is valid.
	if (allowlistSet.has(normalizedTable)) {
		return true;
	}

	// For unowned references, allow a qualified allowlist entry in the default schema.
	if (!normalizedDefaultOwner) {
		return false;
	}

	for (const entry of allowlistSet) {
		const parsed = splitQualifiedName(entry);
		if (parsed.owner === normalizedDefaultOwner && parsed.table === normalizedTable) {
			return true;
		}
	}

	return false;
}
