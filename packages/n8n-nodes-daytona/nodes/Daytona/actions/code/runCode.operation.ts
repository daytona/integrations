import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { TOOLBOX_ENDPOINTS } from '../../helpers/constants';
import {
	createEphemeralSandbox,
	daytonaToolboxRequest,
	safeDeleteSandbox,
} from '../../helpers/transport';
import type { ProcessExecutionResponse } from '../../helpers/types';
import { fixedCollectionToObject, omitUndefined } from '../../helpers/utils';

const showOnly = { resource: ['code'], operation: ['runCode'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Code',
		name: 'code',
		type: 'string',
		required: true,
		default: '',
		typeOptions: { rows: 8 },
		description: 'Code to execute inside the sandbox',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Language',
		name: 'language',
		type: 'options',
		default: 'python',
		description: 'Runtime to execute the code with',
		options: [
			{ name: 'Python', value: 'python' },
			{ name: 'JavaScript', value: 'javascript' },
			{ name: 'TypeScript', value: 'typescript' },
		],
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Use Ephemeral Sandbox',
		name: 'useEphemeralSandbox',
		type: 'boolean',
		default: true,
		description:
			'Whether to create a temporary sandbox just for this execution. The sandbox is auto-deleted afterward. Uncheck to run inside an existing sandbox.',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Sandbox ID',
		name: 'sandboxId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID of the existing sandbox to run the code in',
		displayOptions: { show: { ...showOnly, useEphemeralSandbox: [false] } },
	},
	{
		displayName: 'Snapshot',
		name: 'snapshot',
		type: 'string',
		default: '',
		placeholder: 'snapshot-ID-or-name',
		description:
			'Snapshot to base the ephemeral sandbox on. Leave empty to use the Daytona organization default.',
		displayOptions: { show: { ...showOnly, useEphemeralSandbox: [true] } },
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
				displayName: 'Argv',
				name: 'argv',
				type: 'string',
				default: '',
				placeholder: '--flag value',
				description: 'Space-separated arguments passed to the running script',
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
							{ displayName: 'Name', name: 'name', type: 'string', default: '' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeout',
				type: 'number',
				default: 60,
				typeOptions: { minValue: 1, maxValue: 3600 },
				description: 'Maximum time to wait for the code to finish executing',
			},
			{
				displayName: 'Wait Until Started Timeout (Seconds)',
				name: 'waitTimeoutSeconds',
				type: 'number',
				default: 60,
				typeOptions: { minValue: 1, maxValue: 600 },
				description:
					'Max time to wait for the ephemeral sandbox to reach the "started" state before running the code',
			},
		],
	},
];

interface AdditionalFields {
	argv?: string;
	env?: { entry?: Array<{ name: string; value: string }> };
	timeout?: number;
	waitTimeoutSeconds?: number;
}

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const code = this.getNodeParameter('code', itemIndex) as string;
	const language = this.getNodeParameter('language', itemIndex, 'python') as string;
	const useEphemeral = this.getNodeParameter('useEphemeralSandbox', itemIndex, true) as boolean;
	const additional = this.getNodeParameter('additionalFields', itemIndex, {}) as AdditionalFields;

	const envVars = fixedCollectionToObject(additional.env);
	const timeout = additional.timeout;
	const argv = additional.argv?.trim() ? additional.argv.trim().split(/\s+/) : undefined;

	let sandboxId: string;
	let createdEphemeral = false;
	let cleanup: { deleted: boolean; error?: string } | undefined;

	if (useEphemeral) {
		const snapshot = (this.getNodeParameter('snapshot', itemIndex, '') as string).trim();
		const waitTimeoutSeconds = additional.waitTimeoutSeconds ?? 60;

		const sandbox = await createEphemeralSandbox.call(this, {
			snapshot: snapshot || undefined,
			waitTimeoutMs: waitTimeoutSeconds * 1000,
		});
		sandboxId = sandbox.id;
		createdEphemeral = true;
	} else {
		sandboxId = (this.getNodeParameter('sandboxId', itemIndex) as string).trim();
	}

	const body = omitUndefined({
		code,
		language: language || undefined,
		envs: envVars,
		argv,
		timeout,
	}) as unknown as IDataObject;

	let result: ProcessExecutionResponse;
	try {
		result = (await daytonaToolboxRequest.call(
			this,
			sandboxId,
			'POST',
			TOOLBOX_ENDPOINTS.process.runCode,
			body,
		)) as ProcessExecutionResponse;
	} finally {
		if (createdEphemeral) {
			cleanup = await safeDeleteSandbox.call(this, sandboxId);
		}
	}

	return [
		{
			json: {
				exitCode: result.exitCode,
				result: result.result ?? '',
				artifacts: result.artifacts ?? null,
				sandboxId,
				ephemeral: createdEphemeral,
				...(cleanup && !cleanup.deleted
					? { cleanupWarning: `Failed to delete ephemeral sandbox: ${cleanup.error}` }
					: {}),
			},
			pairedItem: { item: itemIndex },
		},
	];
}
