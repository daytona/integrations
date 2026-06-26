import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { API_ENDPOINTS } from '../../helpers/constants';
import { daytonaApiRequest } from '../../helpers/transport';
import type { Sandbox } from '../../helpers/types';

const showOnly = { resource: ['sandbox'], operation: ['get'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Sandbox ID',
		name: 'sandboxId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID of the sandbox to retrieve',
		displayOptions: { show: showOnly },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const sandboxId = (this.getNodeParameter('sandboxId', itemIndex) as string).trim();

	const sandbox = (await daytonaApiRequest.call(
		this,
		'GET',
		API_ENDPOINTS.sandbox.get(sandboxId),
	)) as Sandbox;

	return [
		{
			json: sandbox as unknown as IDataObject,
			pairedItem: { item: itemIndex },
		},
	];
}
