import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { TOOLBOX_ENDPOINTS } from '../../helpers/constants';
import { daytonaToolboxRequest } from '../../helpers/transport';

const showOnly = { resource: ['git'], operation: ['checkout'] };

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
		displayName: 'Branch',
		name: 'branch',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'main, feature/new-thing, or a commit SHA',
		description: 'Branch name or commit SHA to check out',
		displayOptions: { show: showOnly },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const sandboxId = (this.getNodeParameter('sandboxId', itemIndex) as string).trim();
	const path = (this.getNodeParameter('path', itemIndex) as string).trim();
	const branch = (this.getNodeParameter('branch', itemIndex) as string).trim();

	await daytonaToolboxRequest.call(
		this,
		sandboxId,
		'POST',
		TOOLBOX_ENDPOINTS.git.checkout,
		{ path, branch } as unknown as IDataObject,
	);

	return [
		{
			json: { success: true, sandboxId, path, branch },
			pairedItem: { item: itemIndex },
		},
	];
}
