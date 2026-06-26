import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { API_ENDPOINTS } from '../../helpers/constants';
import { daytonaApiRequest, waitForSnapshotState } from '../../helpers/transport';
import type { CreateSnapshotRequest, Snapshot } from '../../helpers/types';
import { omitUndefined } from '../../helpers/utils';

const showOnly = { resource: ['snapshot'], operation: ['create'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Name',
		name: 'name',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'my-snapshot',
		description: 'Name for the new snapshot (must be unique in the organization)',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Image Name',
		name: 'imageName',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'python:3.11-slim',
		description: 'Docker image to base the snapshot on (must be publicly accessible)',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Wait Until Active',
		name: 'waitUntilActive',
		type: 'boolean',
		default: true,
		description:
			'Whether to poll until the snapshot reaches the "active" state before returning. Recommended when chaining downstream operations (e.g. creating a sandbox from the snapshot).',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Wait Timeout (Seconds)',
		name: 'waitTimeoutSeconds',
		type: 'number',
		default: 600,
		typeOptions: { minValue: 1, maxValue: 1800 },
		description:
			'Maximum time to wait for the snapshot to reach the "active" state. Snapshot creation can take several minutes for large Docker images.',
		displayOptions: { show: { ...showOnly, waitUntilActive: [true] } },
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: showOnly },
		options: [
			{
				displayName: 'CPU',
				name: 'cpu',
				type: 'number',
				default: 0,
				description: 'Number of CPU cores',
			},
			{
				displayName: 'Disk (GB)',
				name: 'disk',
				type: 'number',
				default: 0,
				description: 'Disk space in gigabytes',
			},
			{
				displayName: 'Entrypoint',
				name: 'entrypoint',
				type: 'string',
				default: '',
				placeholder: 'sleep infinity',
				description:
					'Comma-separated entrypoint command and arguments (e.g. <code>sleep infinity</code>)',
			},
			{
				displayName: 'Memory (GB)',
				name: 'memory',
				type: 'number',
				default: 0,
				description: 'Memory in gigabytes',
			},
			{
				displayName: 'Region ID',
				name: 'regionId',
				type: 'string',
				default: '',
				description: 'Daytona region to host the snapshot in',
			},
		],
	},
];

interface AdditionalFields {
	cpu?: number;
	disk?: number;
	entrypoint?: string;
	memory?: number;
	regionId?: string;
}

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const name = (this.getNodeParameter('name', itemIndex) as string).trim();
	const imageName = (this.getNodeParameter('imageName', itemIndex) as string).trim();
	const waitUntilActive = this.getNodeParameter('waitUntilActive', itemIndex, true) as boolean;
	const waitTimeoutSeconds = this.getNodeParameter(
		'waitTimeoutSeconds',
		itemIndex,
		600,
	) as number;
	const additional = this.getNodeParameter('additionalFields', itemIndex, {}) as AdditionalFields;

	const entrypointArray = additional.entrypoint?.trim()
		? additional.entrypoint
				.split(',')
				.map((part) => part.trim())
				.filter((part) => part.length > 0)
		: undefined;

	const body: CreateSnapshotRequest = omitUndefined({
		name,
		imageName,
		cpu: additional.cpu || undefined,
		memory: additional.memory || undefined,
		disk: additional.disk || undefined,
		regionId: additional.regionId?.trim() || undefined,
		entrypoint: entrypointArray,
	}) as CreateSnapshotRequest;

	const created = (await daytonaApiRequest.call(
		this,
		'POST',
		API_ENDPOINTS.snapshot.create,
		body as unknown as IDataObject,
	)) as Snapshot;

	let final: Snapshot = created;
	if (waitUntilActive && created.state !== 'active') {
		final = await waitForSnapshotState.call(this, created.id, {
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
