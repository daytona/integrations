import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { API_ENDPOINTS } from '../../helpers/constants';
import { daytonaApiRequest, waitForSandboxState } from '../../helpers/transport';
import type { CreateSandboxRequest, Sandbox } from '../../helpers/types';
import { fixedCollectionToObject, omitUndefined } from '../../helpers/utils';

const showOnly = { resource: ['sandbox'], operation: ['create'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Snapshot Name or ID',
		name: 'snapshot',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getSnapshots' },
		default: '',
		description:
			'Snapshot to base the sandbox on. Snapshot takes precedence over Image when both are set; leave at <em>(Use Daytona Default)</em> to use the Image field or the organization default snapshot. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Image',
		name: 'image',
		type: 'string',
		default: '',
		placeholder: 'python:3.11',
		description:
			'Docker image reference to base the sandbox on (e.g. <code>python:3.11</code> or <code>node:20-slim</code>). Used only when Snapshot is empty. Pulled at sandbox creation time.',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Name',
		name: 'name',
		type: 'string',
		default: '',
		description: 'Optional human-friendly name for the sandbox',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Ephemeral',
		name: 'ephemeral',
		type: 'boolean',
		default: false,
		description:
			'Whether the sandbox is auto-deleted as soon as it stops. Equivalent to setting Auto-Delete Interval to 0.',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Wait Until Started',
		name: 'waitUntilStarted',
		type: 'boolean',
		default: true,
		description: 'Whether to poll until the sandbox reaches the "started" state before returning',
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
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: showOnly },
		options: [
			{
				displayName: 'Auto-Archive Interval (Minutes)',
				name: 'autoArchiveInterval',
				type: 'number',
				default: 0,
				description:
					'Minutes a stopped sandbox can stay before being archived. 0 disables.',
			},
			{
				displayName: 'Auto-Delete Interval (Minutes)',
				name: 'autoDeleteInterval',
				type: 'number',
				default: 0,
				description:
					'Minutes a stopped sandbox can stay before being deleted. 0 deletes immediately on stop (ephemeral). -1 disables.',
			},
			{
				displayName: 'Auto-Stop Interval (Minutes)',
				name: 'autoStopInterval',
				type: 'number',
				default: 0,
				description: 'Minutes of inactivity before the sandbox is auto-stopped. 0 disables.',
			},
			{
				displayName: 'CPU',
				name: 'cpu',
				type: 'number',
				default: 0,
				description:
					'Number of CPU cores. 0 to use the class default. Only honored with Image-based creates; ignored when creating from a Snapshot (the snapshot defines its own resources).',
			},
			{
				displayName: 'Disk (GB)',
				name: 'disk',
				type: 'number',
				default: 0,
				description:
					'Disk space in gigabytes. 0 to use the class default. Only honored with Image-based creates; ignored when creating from a Snapshot.',
			},
			{
				displayName: 'Environment Variables',
				name: 'env',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Environment Variable',
				default: {},
				options: [
					{
						name: 'entry',
						displayName: 'Variable',
						values: [
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
								description: 'Name of the environment variable',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								description: 'Value of the environment variable',
							},
						],
					},
				],
			},
			{
				displayName: 'Labels',
				name: 'labels',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Label',
				default: {},
				options: [
					{
						name: 'entry',
						displayName: 'Label',
						values: [
							{
								displayName: 'Key',
								name: 'name',
								type: 'string',
								default: '',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
							},
						],
					},
				],
			},
			{
				displayName: 'Memory (GB)',
				name: 'memory',
				type: 'number',
				default: 0,
				description:
					'Memory in gigabytes. 0 to use the class default. Only honored with Image-based creates; ignored when creating from a Snapshot.',
			},
			{
				displayName: 'Network Allow List',
				name: 'networkAllowList',
				type: 'string',
				default: '',
				placeholder: '208.80.154.232/32,10.0.0.0/8',
				description: 'Comma-separated CIDR list of allowed outbound destinations',
			},
			{
				displayName: 'Network Block All',
				name: 'networkBlockAll',
				type: 'boolean',
				default: false,
				description: 'Whether to block all outbound network access',
			},
			{
				displayName: 'Public',
				name: 'public',
				type: 'boolean',
				default: false,
				description: 'Whether to enable public preview URLs for this sandbox',
			},
			{
				displayName: 'Target Region',
				name: 'target',
				type: 'string',
				default: '',
				placeholder: 'us',
				description:
					'Daytona region to create the sandbox in (e.g. "us", "eu"). Leave empty for the organization default.',
			},
			{
				displayName: 'User',
				name: 'user',
				type: 'string',
				default: '',
				description: 'OS user inside the sandbox. Defaults to "daytona".',
			},
			{
				displayName: 'Volume Mounts',
				name: 'volumes',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Volume Mount',
				default: {},
				description:
					'Volumes to mount into the sandbox. Create volumes via the Volume resource first.',
				options: [
					{
						name: 'entry',
						displayName: 'Volume Mount',
						values: [
							{
								displayName: 'Volume ID',
								name: 'volumeId',
								type: 'string',
								default: '',
								description: 'UUID of the volume to mount',
							},
							{
								displayName: 'Mount Path',
								name: 'mountPath',
								type: 'string',
								default: '',
								placeholder: '/home/daytona/data',
								description: 'Absolute path inside the sandbox where the volume is mounted',
							},
							{
								displayName: 'Subpath',
								name: 'subpath',
								type: 'string',
								default: '',
								description:
									'Optional subpath/prefix within the volume to mount. When omitted, the entire volume is mounted.',
							},
						],
					},
				],
			},
		],
	},
];

interface AdditionalFields {
	autoArchiveInterval?: number;
	autoDeleteInterval?: number;
	autoStopInterval?: number;
	class?: string;
	cpu?: number;
	disk?: number;
	env?: { entry?: Array<{ name: string; value: string }> };
	labels?: { entry?: Array<{ name: string; value: string }> };
	memory?: number;
	networkAllowList?: string;
	networkBlockAll?: boolean;
	public?: boolean;
	target?: string;
	user?: string;
	volumes?: { entry?: Array<{ volumeId: string; mountPath: string; subpath?: string }> };
}

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const snapshot = (this.getNodeParameter('snapshot', itemIndex, '') as string).trim();
	const image = (this.getNodeParameter('image', itemIndex, '') as string).trim();
	const name = (this.getNodeParameter('name', itemIndex, '') as string).trim();
	const ephemeral = this.getNodeParameter('ephemeral', itemIndex, false) as boolean;
	const waitUntilStarted = this.getNodeParameter('waitUntilStarted', itemIndex, true) as boolean;
	const waitTimeoutSeconds = this.getNodeParameter('waitTimeoutSeconds', itemIndex, 60) as number;
	const additional = this.getNodeParameter(
		'additionalFields',
		itemIndex,
		{},
	) as AdditionalFields;

	const isImageBased = !snapshot && Boolean(image);
	const buildInfo = isImageBased ? { dockerfileContent: `FROM ${image}` } : undefined;

	const volumeMounts = additional.volumes?.entry
		?.filter((v) => v.volumeId?.trim() && v.mountPath?.trim())
		.map((v) => {
			const mount: { volumeId: string; mountPath: string; subpath?: string } = {
				volumeId: v.volumeId.trim(),
				mountPath: v.mountPath.trim(),
			};
			if (v.subpath?.trim()) mount.subpath = v.subpath.trim();
			return mount;
		});

	// Ephemeral wins per Daytona SDK convention: when ephemeral=true, autoDeleteInterval
	// is forced to 0 regardless of any explicit value the user set in Additional Fields.
	const explicitAutoDelete =
		typeof additional.autoDeleteInterval === 'number' ? additional.autoDeleteInterval : undefined;
	const autoDeleteInterval = ephemeral ? 0 : explicitAutoDelete;

	const body: CreateSandboxRequest = omitUndefined({
		snapshot: snapshot || undefined,
		buildInfo,
		name: name || undefined,
		user: additional.user || undefined,
		public: additional.public || undefined,
		target: additional.target || undefined,
		cpu: isImageBased ? additional.cpu || undefined : undefined,
		memory: isImageBased ? additional.memory || undefined : undefined,
		disk: isImageBased ? additional.disk || undefined : undefined,
		autoStopInterval: additional.autoStopInterval || undefined,
		autoArchiveInterval: additional.autoArchiveInterval || undefined,
		autoDeleteInterval,
		networkBlockAll: additional.networkBlockAll || undefined,
		networkAllowList: additional.networkAllowList || undefined,
		env: fixedCollectionToObject(additional.env),
		labels: fixedCollectionToObject(additional.labels),
		volumes: volumeMounts && volumeMounts.length > 0 ? volumeMounts : undefined,
	}) as CreateSandboxRequest;

	const created = (await daytonaApiRequest.call(
		this,
		'POST',
		API_ENDPOINTS.sandbox.create,
		body as unknown as IDataObject,
	)) as Sandbox;

	const sandboxId = created.id;

	let final: Sandbox = created;
	if (waitUntilStarted && created.state !== 'started') {
		final = await waitForSandboxState.call(this, sandboxId, {
			targetStates: ['started'],
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
