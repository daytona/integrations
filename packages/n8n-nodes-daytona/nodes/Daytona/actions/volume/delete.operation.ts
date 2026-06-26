import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { API_ENDPOINTS } from '../../helpers/constants';
import { daytonaApiRequest } from '../../helpers/transport';

const showOnly = { resource: ['volume'], operation: ['delete'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Volume ID',
		name: 'volumeId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID or name of the volume to delete',
		displayOptions: { show: showOnly },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const volumeId = (this.getNodeParameter('volumeId', itemIndex) as string).trim();

	await daytonaApiRequest.call(this, 'DELETE', API_ENDPOINTS.volume.delete(volumeId));

	return [
		{
			json: { success: true, volumeId },
			pairedItem: { item: itemIndex },
		},
	];
}
