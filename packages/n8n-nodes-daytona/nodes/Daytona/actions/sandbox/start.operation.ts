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

const showOnly = { resource: ['sandbox'], operation: ['start'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Sandbox ID',
		name: 'sandboxId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID of the sandbox to start',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Wait Until Started',
		name: 'waitUntilStarted',
		type: 'boolean',
		default: true,
		description: 'Whether to poll the sandbox until it reaches the "started" state before returning',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Wait Timeout (Seconds)',
		name: 'waitTimeoutSeconds',
		type: 'number',
		default: 60,
		typeOptions: { minValue: 1, maxValue: 600 },
		description: 'Maximum time to wait for the sandbox to reach the "started" state',
		displayOptions: { show: { ...showOnly, waitUntilStarted: [true] } },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const sandboxId = (this.getNodeParameter('sandboxId', itemIndex) as string).trim();
	const waitUntilStarted = this.getNodeParameter('waitUntilStarted', itemIndex, true) as boolean;
	const waitTimeoutSeconds = this.getNodeParameter('waitTimeoutSeconds', itemIndex, 60) as number;

	await daytonaApiRequest.call(this, 'POST', API_ENDPOINTS.sandbox.start(sandboxId));

	invalidateToolboxCache(this, sandboxId);

	let sandbox: Sandbox;
	if (waitUntilStarted) {
		sandbox = await waitForSandboxState.call(this, sandboxId, {
			targetStates: ['started'],
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
