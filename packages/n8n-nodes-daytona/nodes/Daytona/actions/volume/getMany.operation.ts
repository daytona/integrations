import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { API_ENDPOINTS } from '../../helpers/constants';
import { daytonaApiRequest } from '../../helpers/transport';
import type { Volume } from '../../helpers/types';

const showOnly = { resource: ['volume'], operation: ['getMany'] };

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
		typeOptions: { minValue: 1, maxValue: 100 },
		description: 'Max number of results to return',
		displayOptions: { show: { ...showOnly, returnAll: [false] } },
	},
	{
		displayName: 'Include Deleted',
		name: 'includeDeleted',
		type: 'boolean',
		default: false,
		description: 'Whether to include soft-deleted volumes in the response',
		displayOptions: { show: showOnly },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
	const includeDeleted = this.getNodeParameter('includeDeleted', itemIndex, false) as boolean;

	const qs: IDataObject = {};
	if (includeDeleted) qs.includeDeleted = true;

	const response = (await daytonaApiRequest.call(
		this,
		'GET',
		API_ENDPOINTS.volume.list,
		undefined,
		qs,
	)) as Volume[];

	const volumes = Array.isArray(response) ? response : [];
	const trimmed = returnAll ? volumes : volumes.slice(0, limit);

	return trimmed.map((volume) => ({
		json: volume as unknown as IDataObject,
		pairedItem: { item: itemIndex },
	}));
}
