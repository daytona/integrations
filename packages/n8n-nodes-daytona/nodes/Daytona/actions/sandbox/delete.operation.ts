import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { API_ENDPOINTS } from '../../helpers/constants';
import { daytonaApiRequest, invalidateToolboxCache } from '../../helpers/transport';

const showOnly = { resource: ['sandbox'], operation: ['delete'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Sandbox ID',
		name: 'sandboxId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID of the sandbox to delete',
		displayOptions: { show: showOnly },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const sandboxId = (this.getNodeParameter('sandboxId', itemIndex) as string).trim();

	await daytonaApiRequest.call(this, 'DELETE', API_ENDPOINTS.sandbox.delete(sandboxId));
	invalidateToolboxCache(this, sandboxId);

	return [
		{
			json: { success: true, sandboxId },
			pairedItem: { item: itemIndex },
		},
	];
}
