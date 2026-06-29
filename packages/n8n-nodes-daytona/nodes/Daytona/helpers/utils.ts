import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

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

/**
 * Trim a required string parameter and throw a NodeOperationError when it is
 * empty after trimming. n8n's `required: true` only blocks an empty field in
 * the editor UI — it does not catch whitespace-only input or expressions that
 * resolve to an empty string. Without this guard those slip through and hit the
 * API as malformed requests (e.g. `DELETE /volumes/` with no id).
 */
export function requireNonEmpty(
	ctx: IExecuteFunctions,
	value: string,
	displayName: string,
	itemIndex: number,
): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new NodeOperationError(
			ctx.getNode(),
			`${displayName} is required and cannot be empty.`,
			{ itemIndex },
		);
	}
	return trimmed;
}
