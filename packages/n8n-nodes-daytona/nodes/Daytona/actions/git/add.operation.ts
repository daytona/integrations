import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { TOOLBOX_ENDPOINTS } from '../../helpers/constants';
import { daytonaToolboxRequest } from '../../helpers/transport';

const showOnly = { resource: ['git'], operation: ['add'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Sandbox ID',
		name: 'sandboxId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID of the sandbox containing the Git repository',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Path',
		name: 'path',
		type: 'string',
		required: true,
		default: '',
		placeholder: '/home/daytona/repo',
		description: 'Absolute path inside the sandbox to the Git repository',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Files',
		name: 'files',
		type: 'string',
		required: true,
		default: '.',
		placeholder: '. or README.md,src/index.ts',
		description:
			'Comma-separated list of files to stage. Use <code>.</code> to stage everything.',
		displayOptions: { show: showOnly },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const sandboxId = (this.getNodeParameter('sandboxId', itemIndex) as string).trim();
	const path = (this.getNodeParameter('path', itemIndex) as string).trim();
	const filesRaw = (this.getNodeParameter('files', itemIndex) as string).trim();

	const files = filesRaw
		.split(',')
		.map((f) => f.trim())
		.filter((f) => f.length > 0);

	await daytonaToolboxRequest.call(
		this,
		sandboxId,
		'POST',
		TOOLBOX_ENDPOINTS.git.add,
		{ path, files } as unknown as IDataObject,
	);

	return [
		{
			json: { success: true, sandboxId, path, files },
			pairedItem: { item: itemIndex },
		},
	];
}
