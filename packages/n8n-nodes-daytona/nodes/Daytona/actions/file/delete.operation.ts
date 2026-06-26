import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { TOOLBOX_ENDPOINTS } from '../../helpers/constants';
import { daytonaToolboxRequest } from '../../helpers/transport';

const showOnly = { resource: ['file'], operation: ['delete'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Sandbox ID',
		name: 'sandboxId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID of the sandbox containing the file or directory',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Path',
		name: 'path',
		type: 'string',
		required: true,
		default: '',
		placeholder: '/home/daytona/file.txt',
		description: 'Absolute path inside the sandbox of the file or directory to delete',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Recursive',
		name: 'recursive',
		type: 'boolean',
		default: false,
		description:
			'Whether to delete directories and their contents recursively. Required to delete a non-empty directory.',
		displayOptions: { show: showOnly },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const sandboxId = (this.getNodeParameter('sandboxId', itemIndex) as string).trim();
	const path = (this.getNodeParameter('path', itemIndex) as string).trim();
	const recursive = this.getNodeParameter('recursive', itemIndex, false) as boolean;

	const qs: IDataObject = { path };
	if (recursive) qs.recursive = true;

	await daytonaToolboxRequest.call(
		this,
		sandboxId,
		'DELETE',
		TOOLBOX_ENDPOINTS.files.delete,
		undefined,
		qs,
	);

	return [
		{
			json: { success: true, sandboxId, path, recursive },
			pairedItem: { item: itemIndex },
		},
	];
}
