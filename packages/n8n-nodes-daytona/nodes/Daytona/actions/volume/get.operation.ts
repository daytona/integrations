import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { API_ENDPOINTS } from '../../helpers/constants';
import { daytonaApiRequest } from '../../helpers/transport';
import type { Volume } from '../../helpers/types';

const showOnly = { resource: ['volume'], operation: ['get'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Volume ID',
		name: 'volumeId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID or name of the volume to retrieve',
		displayOptions: { show: showOnly },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const volumeId = (this.getNodeParameter('volumeId', itemIndex) as string).trim();

	const volume = (await daytonaApiRequest.call(
		this,
		'GET',
		API_ENDPOINTS.volume.get(volumeId),
	)) as Volume;

	return [
		{
			json: volume as unknown as IDataObject,
			pairedItem: { item: itemIndex },
		},
	];
}
