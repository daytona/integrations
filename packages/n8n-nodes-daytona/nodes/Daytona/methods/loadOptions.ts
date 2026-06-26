import type { ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';

import { API_ENDPOINTS } from '../helpers/constants';
import { daytonaApiRequest } from '../helpers/transport';
import type { PaginatedResponse, Snapshot } from '../helpers/types';

const MAX_SNAPSHOTS = 100;

export async function getSnapshots(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const response = (await daytonaApiRequest.call(
		this,
		'GET',
		API_ENDPOINTS.snapshot.list,
		undefined,
		{ limit: MAX_SNAPSHOTS, sort: 'lastUsedAt', order: 'desc' },
	)) as PaginatedResponse<Snapshot> | Snapshot[];

	const items = Array.isArray(response) ? response : (response?.items ?? []);

	const options: INodePropertyOptions[] = [
		{
			name: '(Use Daytona Default)',
			value: '',
			description: 'Use the organization default snapshot',
		},
	];

	for (const snapshot of items) {
		const label =
			(snapshot.name as string | undefined) ?? (snapshot.id as string | undefined) ?? '';
		const value = (snapshot.name as string | undefined) ?? (snapshot.id as string | undefined) ?? '';
		if (!label || !value) continue;
		const stateSuffix = snapshot.state ? ` (${snapshot.state})` : '';
		options.push({
			name: `${label}${stateSuffix}`,
			value,
		});
	}

	return options;
}
