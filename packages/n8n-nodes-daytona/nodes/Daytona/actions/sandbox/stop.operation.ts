import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { API_ENDPOINTS } from '../../helpers/constants';
import {
	daytonaApiRequest,
	invalidateToolboxCache,
	waitForSandboxState,
} from '../../helpers/transport';
import type { Sandbox } from '../../helpers/types';

const showOnly = { resource: ['sandbox'], operation: ['stop'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Sandbox ID',
		name: 'sandboxId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID of the sandbox to stop',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Wait Until Stopped',
		name: 'waitUntilStopped',
		type: 'boolean',
		default: false,
		description: 'Whether to poll the sandbox until it reaches the "stopped" state before returning',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Wait Timeout (Seconds)',
		name: 'waitTimeoutSeconds',
		type: 'number',
		default: 60,
		typeOptions: { minValue: 1, maxValue: 600 },
		description: 'Maximum time to wait for the sandbox to reach the "stopped" state',
		displayOptions: { show: { ...showOnly, waitUntilStopped: [true] } },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const sandboxId = (this.getNodeParameter('sandboxId', itemIndex) as string).trim();
	const waitUntilStopped = this.getNodeParameter('waitUntilStopped', itemIndex, false) as boolean;
	const waitTimeoutSeconds = this.getNodeParameter('waitTimeoutSeconds', itemIndex, 60) as number;

	await daytonaApiRequest.call(this, 'POST', API_ENDPOINTS.sandbox.stop(sandboxId));

	invalidateToolboxCache(this, sandboxId);

	let sandbox: Sandbox;
	if (waitUntilStopped) {
		sandbox = await waitForSandboxState.call(this, sandboxId, {
			targetStates: ['stopped', 'archived'],
			timeoutMs: waitTimeoutSeconds * 1000,
		});
	} else {
		sandbox = (await daytonaApiRequest.call(
			this,
			'GET',
			API_ENDPOINTS.sandbox.get(sandboxId),
		)) as Sandbox;
	}

	return [
		{
			json: sandbox as unknown as IDataObject,
			pairedItem: { item: itemIndex },
		},
	];
}
