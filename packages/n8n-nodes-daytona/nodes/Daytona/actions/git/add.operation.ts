import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { TOOLBOX_ENDPOINTS } from '../../helpers/constants';
import { daytonaToolboxRequest } from '../../helpers/transport';
import { requireNonEmpty } from '../../helpers/utils';

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
	const sandboxId = requireNonEmpty(this, this.getNodeParameter('sandboxId', itemIndex) as string, 'Sandbox ID', itemIndex);
	const path = requireNonEmpty(this, this.getNodeParameter('path', itemIndex) as string, 'Path', itemIndex);
	const filesRaw = (this.getNodeParameter('files', itemIndex) as string).trim();

	const files = filesRaw
		.split(',')
		.map((f) => f.trim())
		.filter((f) => f.length > 0);

	if (files.length === 0) {
		throw new NodeOperationError(
			this.getNode(),
			'Files is required: provide a comma-separated list of paths to stage, or "." to stage everything.',
			{ itemIndex },
		);
	}

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
