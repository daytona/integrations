import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { API_ENDPOINTS } from '../../helpers/constants';
import { daytonaApiRequest, waitForSnapshotState } from '../../helpers/transport';
import type { Snapshot } from '../../helpers/types';

const showOnly = { resource: ['snapshot'], operation: ['deactivate'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Snapshot ID',
		name: 'snapshotId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID or name of the snapshot to deactivate',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Wait Until Inactive',
		name: 'waitUntilInactive',
		type: 'boolean',
		default: true,
		description:
			'Whether to poll until the snapshot reaches the "inactive" state before returning',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Wait Timeout (Seconds)',
		name: 'waitTimeoutSeconds',
		type: 'number',
		default: 120,
		typeOptions: { minValue: 1, maxValue: 600 },
		description: 'Maximum time to wait for the snapshot to reach the "inactive" state',
		displayOptions: { show: { ...showOnly, waitUntilInactive: [true] } },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const snapshotId = (this.getNodeParameter('snapshotId', itemIndex) as string).trim();
	const waitUntilInactive = this.getNodeParameter(
		'waitUntilInactive',
		itemIndex,
		true,
	) as boolean;
	const waitTimeoutSeconds = this.getNodeParameter(
		'waitTimeoutSeconds',
		itemIndex,
		120,
	) as number;

	const snapshot = (await daytonaApiRequest.call(
		this,
		'POST',
		API_ENDPOINTS.snapshot.deactivate(snapshotId),
	)) as Snapshot | undefined;

	let final: Snapshot | undefined = snapshot;
	if (waitUntilInactive && (!snapshot || snapshot.state !== 'inactive')) {
		final = await waitForSnapshotState.call(this, snapshotId, {
			targetStates: ['inactive'],
			timeoutMs: waitTimeoutSeconds * 1000,
		});
	}

	return [
		{
			json: (final ?? { id: snapshotId, deactivated: true }) as unknown as IDataObject,
			pairedItem: { item: itemIndex },
		},
	];
}
