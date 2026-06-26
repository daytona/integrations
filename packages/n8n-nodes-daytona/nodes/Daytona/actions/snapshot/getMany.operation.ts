import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { API_ENDPOINTS } from '../../helpers/constants';
import { daytonaApiRequest } from '../../helpers/transport';
import type { PaginatedResponse, Snapshot } from '../../helpers/types';

const showOnly = { resource: ['snapshot'], operation: ['getMany'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 1, maxValue: 200 },
		description: 'Max number of results to return',
		displayOptions: { show: { ...showOnly, returnAll: [false] } },
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: showOnly },
		options: [
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				description: 'Filter by snapshot name (substring match)',
			},
			{
				displayName: 'Sort By',
				name: 'sort',
				type: 'options',
				default: 'lastUsedAt',
				options: [
					{ name: 'Created At', value: 'createdAt' },
					{ name: 'Last Used At', value: 'lastUsedAt' },
					{ name: 'Name', value: 'name' },
					{ name: 'State', value: 'state' },
				],
			},
			{
				displayName: 'Order',
				name: 'order',
				type: 'options',
				default: 'desc',
				options: [
					{ name: 'Ascending', value: 'asc' },
					{ name: 'Descending', value: 'desc' },
				],
			},
		],
	},
];

interface Filters {
	name?: string;
	sort?: string;
	order?: string;
}

const PAGE_SIZE = 100;

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
	const filters = this.getNodeParameter('filters', itemIndex, {}) as Filters;

	const collected: Snapshot[] = [];
	let page = 1;
	const pageLimit = returnAll ? PAGE_SIZE : limit;

	while (true) {
		const qs: IDataObject = { page, limit: pageLimit };
		if (filters.name?.trim()) qs.name = filters.name.trim();
		if (filters.sort) qs.sort = filters.sort;
		if (filters.order) qs.order = filters.order;

		const response = (await daytonaApiRequest.call(
			this,
			'GET',
			API_ENDPOINTS.snapshot.list,
			undefined,
			qs,
		)) as PaginatedResponse<Snapshot> | Snapshot[];

		const batch = Array.isArray(response) ? response : (response?.items ?? []);
		collected.push(...batch);

		if (!returnAll) break;
		if (batch.length < pageLimit) break;
		if (!Array.isArray(response) && response?.hasMore === false) break;
		if (!Array.isArray(response) && response?.totalPages && page >= response.totalPages) break;
		page++;
	}

	return collected.map((snapshot) => ({
		json: snapshot as unknown as IDataObject,
		pairedItem: { item: itemIndex },
	}));
}
