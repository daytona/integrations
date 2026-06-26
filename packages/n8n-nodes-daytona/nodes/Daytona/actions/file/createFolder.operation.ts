import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { TOOLBOX_ENDPOINTS } from '../../helpers/constants';
import { daytonaToolboxRequest } from '../../helpers/transport';

const showOnly = { resource: ['file'], operation: ['createFolder'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Sandbox ID',
		name: 'sandboxId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID of the sandbox to create the folder in',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Path',
		name: 'path',
		type: 'string',
		required: true,
		default: '',
		placeholder: '/home/daytona/new-folder',
		description: 'Absolute path inside the sandbox where the folder should be created',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Mode',
		name: 'mode',
		type: 'string',
		required: true,
		default: '0755',
		placeholder: '0755',
		description:
			'Unix-style octal permissions for the new folder (e.g. <code>0755</code> for rwxr-xr-x, <code>0700</code> for owner-only)',
		displayOptions: { show: showOnly },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const sandboxId = (this.getNodeParameter('sandboxId', itemIndex) as string).trim();
	const path = (this.getNodeParameter('path', itemIndex) as string).trim();
	const mode = (this.getNodeParameter('mode', itemIndex) as string).trim();

	await daytonaToolboxRequest.call(
		this,
		sandboxId,
		'POST',
		TOOLBOX_ENDPOINTS.files.folder,
		undefined,
		{ path, mode },
	);

	return [
		{
			json: { success: true, sandboxId, path, mode },
			pairedItem: { item: itemIndex },
		},
	];
}
