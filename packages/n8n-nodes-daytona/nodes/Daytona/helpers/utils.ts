interface KeyValueEntry {
	name?: string;
	value?: string;
}

interface FixedCollectionShape {
	entry?: KeyValueEntry[];
	[k: string]: unknown;
}

export function fixedCollectionToObject(
	collection: FixedCollectionShape | undefined,
	entryKey = 'entry',
): Record<string, string> | undefined {
	const entries = collection?.[entryKey] as KeyValueEntry[] | undefined;
	if (!Array.isArray(entries) || entries.length === 0) return undefined;

	const result: Record<string, string> = {};
	for (const { name, value } of entries) {
		if (typeof name === 'string' && name.length > 0) {
			result[name] = typeof value === 'string' ? value : '';
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const result: Partial<T> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined && value !== '' && value !== null) {
			result[key as keyof T] = value as T[keyof T];
		}
	}
	return result;
}
