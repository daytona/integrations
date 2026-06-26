import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { API_ENDPOINTS } from '../../helpers/constants';
import { daytonaApiRequest } from '../../helpers/transport';
import type { CreateVolumeRequest, Volume } from '../../helpers/types';

const showOnly = { resource: ['volume'], operation: ['create'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Name',
		name: 'name',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'my-volume',
		description: 'Name for the new volume',
		displayOptions: { show: showOnly },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const name = (this.getNodeParameter('name', itemIndex) as string).trim();
	const body: CreateVolumeRequest = { name };

	const volume = (await daytonaApiRequest.call(
		this,
		'POST',
		API_ENDPOINTS.volume.create,
		body as unknown as IDataObject,
	)) as Volume;

	return [
		{
			json: volume as unknown as IDataObject,
			pairedItem: { item: itemIndex },
		},
	];
}
