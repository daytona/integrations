import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { API_ENDPOINTS } from '../../helpers/constants';
import { daytonaApiRequest } from '../../helpers/transport';

const showOnly = { resource: ['snapshot'], operation: ['delete'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Snapshot ID',
		name: 'snapshotId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID or name of the snapshot to delete',
		displayOptions: { show: showOnly },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const snapshotId = (this.getNodeParameter('snapshotId', itemIndex) as string).trim();

	await daytonaApiRequest.call(this, 'DELETE', API_ENDPOINTS.snapshot.delete(snapshotId));

	return [
		{
			json: { success: true, snapshotId },
			pairedItem: { item: itemIndex },
		},
	];
}
