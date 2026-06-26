import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { API_ENDPOINTS } from '../../helpers/constants';
import { daytonaApiRequest, waitForSnapshotState } from '../../helpers/transport';
import type { Snapshot } from '../../helpers/types';

const showOnly = { resource: ['snapshot'], operation: ['activate'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Snapshot ID',
		name: 'snapshotId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID or name of the snapshot to activate',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Wait Until Active',
		name: 'waitUntilActive',
		type: 'boolean',
		default: true,
		description:
			'Whether to poll until the snapshot reaches the "active" state before returning',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Wait Timeout (Seconds)',
		name: 'waitTimeoutSeconds',
		type: 'number',
		default: 120,
		typeOptions: { minValue: 1, maxValue: 600 },
		description: 'Maximum time to wait for the snapshot to reach the "active" state',
		displayOptions: { show: { ...showOnly, waitUntilActive: [true] } },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const snapshotId = (this.getNodeParameter('snapshotId', itemIndex) as string).trim();
	const waitUntilActive = this.getNodeParameter('waitUntilActive', itemIndex, true) as boolean;
	const waitTimeoutSeconds = this.getNodeParameter(
		'waitTimeoutSeconds',
		itemIndex,
		120,
	) as number;

	const snapshot = (await daytonaApiRequest.call(
		this,
		'POST',
		API_ENDPOINTS.snapshot.activate(snapshotId),
	)) as Snapshot;

	let final: Snapshot = snapshot;
	if (waitUntilActive && snapshot.state !== 'active') {
		final = await waitForSnapshotState.call(this, snapshotId, {
			targetStates: ['active'],
			timeoutMs: waitTimeoutSeconds * 1000,
		});
	}

	return [
		{
			json: final as unknown as IDataObject,
			pairedItem: { item: itemIndex },
		},
	];
}
