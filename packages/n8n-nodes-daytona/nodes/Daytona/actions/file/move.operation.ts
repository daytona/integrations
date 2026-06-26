import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { TOOLBOX_ENDPOINTS } from '../../helpers/constants';
import { daytonaToolboxRequest } from '../../helpers/transport';

const showOnly = { resource: ['file'], operation: ['move'] };

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
		displayName: 'Source',
		name: 'source',
		type: 'string',
		required: true,
		default: '',
		placeholder: '/home/daytona/old-name.txt',
		description: 'Absolute path of the file or directory to move',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Destination',
		name: 'destination',
		type: 'string',
		required: true,
		default: '',
		placeholder: '/home/daytona/new-name.txt',
		description: 'Absolute destination path. Use a different name to rename in place.',
		displayOptions: { show: showOnly },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const sandboxId = (this.getNodeParameter('sandboxId', itemIndex) as string).trim();
	const source = (this.getNodeParameter('source', itemIndex) as string).trim();
	const destination = (this.getNodeParameter('destination', itemIndex) as string).trim();

	await daytonaToolboxRequest.call(
		this,
		sandboxId,
		'POST',
		TOOLBOX_ENDPOINTS.files.move,
		undefined,
		{ source, destination },
	);

	return [
		{
			json: { success: true, sandboxId, source, destination },
			pairedItem: { item: itemIndex },
		},
	];
}
