import type { ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';

import { API_ENDPOINTS } from '../helpers/constants';
import { daytonaApiRequest } from '../helpers/transport';
import type { PaginatedResponse, Snapshot } from '../helpers/types';

const PAGE_SIZE = 100;
// Safety cap so the picker stays responsive for very large organizations.
const MAX_SNAPSHOTS = 1000;

export async function getSnapshots(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const items: Snapshot[] = [];
	let page = 1;

	// Page through results so snapshots beyond the first page still appear in the
	// picker. The list endpoint returns `total`/`totalPages`, so we stop on those
	// rather than assuming a fixed server page size (the API documents no hard cap
	// on `limit` and only a default of 10).
	while (items.length < MAX_SNAPSHOTS) {
		const response = (await daytonaApiRequest.call(
			this,
			'GET',
			API_ENDPOINTS.snapshot.list,
			undefined,
			{ page, limit: PAGE_SIZE, sort: 'lastUsedAt', order: 'desc' },
		)) as PaginatedResponse<Snapshot> | Snapshot[];

		const batch = Array.isArray(response) ? response : (response?.items ?? []);
		items.push(...batch);

		if (batch.length === 0) break; // no progress — guard against an infinite loop
		if (Array.isArray(response)) break; // unpaginated array response — single page
		if (response.totalPages && page >= response.totalPages) break; // reached the last page
		if (response.total !== undefined && items.length >= response.total) break; // collected everything
		// Last resort when the response carries no pagination metadata at all.
		if (response.totalPages === undefined && response.total === undefined && batch.length < PAGE_SIZE) {
			break;
		}
		page++;
	}

	const options: INodePropertyOptions[] = [
		{
			name: '(Use Daytona Default)',
			value: '',
			description: 'Use the organization default snapshot',
		},
	];

	for (const snapshot of items) {
		const id = (snapshot.id as string | undefined)?.trim();
		const name = (snapshot.name as string | undefined)?.trim();
		// Submit the immutable id as the value (names can collide); show the
		// friendly name in the label, falling back to the id when unnamed.
		// Truthy (not nullish) fallback so an empty-string id/name is skipped over
		// rather than selected, and a blank name still shows the id in the label.
		const value = id || name;
		if (!value) continue;
		const stateSuffix = snapshot.state ? ` (${snapshot.state})` : '';
		options.push({
			name: `${name || id}${stateSuffix}`,
			value,
		});
	}

	return options;
}
