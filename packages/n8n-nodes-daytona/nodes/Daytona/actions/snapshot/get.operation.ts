import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { API_ENDPOINTS } from '../../helpers/constants';
import { daytonaApiRequest } from '../../helpers/transport';
import type { Snapshot } from '../../helpers/types';

const showOnly = { resource: ['snapshot'], operation: ['get'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Snapshot ID',
		name: 'snapshotId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID or name of the snapshot to retrieve',
		displayOptions: { show: showOnly },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const snapshotId = (this.getNodeParameter('snapshotId', itemIndex) as string).trim();

	const snapshot = (await daytonaApiRequest.call(
		this,
		'GET',
		API_ENDPOINTS.snapshot.get(snapshotId),
	)) as Snapshot;

	return [
		{
			json: snapshot as unknown as IDataObject,
			pairedItem: { item: itemIndex },
		},
	];
}
