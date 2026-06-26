import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { TOOLBOX_ENDPOINTS } from '../../helpers/constants';
import { daytonaToolboxRequest } from '../../helpers/transport';

const showOnly = { resource: ['file'], operation: ['list'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Sandbox ID',
		name: 'sandboxId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID of the sandbox to list files in',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Path',
		name: 'path',
		type: 'string',
		required: true,
		default: '',
		placeholder: '/home/daytona',
		description: 'Absolute directory path inside the sandbox to list',
		displayOptions: { show: showOnly },
	},
];

interface FileInfo {
	name: string;
	isDir: boolean;
	size: number;
	mode: string;
	modTime: string;
	owner: string;
	group: string;
	permissions: string;
}

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const sandboxId = (this.getNodeParameter('sandboxId', itemIndex) as string).trim();
	const path = (this.getNodeParameter('path', itemIndex) as string).trim();

	const response = (await daytonaToolboxRequest.call(
		this,
		sandboxId,
		'GET',
		TOOLBOX_ENDPOINTS.files.list,
		undefined,
		{ path },
	)) as FileInfo[];

	const files = Array.isArray(response) ? response : [];

	return [
		{
			json: {
				sandboxId,
				path,
				count: files.length,
				files,
			} as unknown as IDataObject,
			pairedItem: { item: itemIndex },
		},
	];
}
