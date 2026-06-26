import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { TOOLBOX_ENDPOINTS } from '../../helpers/constants';
import { daytonaToolboxRequest } from '../../helpers/transport';
import { omitUndefined } from '../../helpers/utils';

const showOnly = { resource: ['git'], operation: ['push'] };

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
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: showOnly },
		options: [
			{
				displayName: 'Username',
				name: 'username',
				type: 'string',
				default: '',
				description: 'HTTPS username for the remote',
			},
			{
				displayName: 'Password',
				name: 'password',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				description: 'HTTPS password or personal access token for the remote',
			},
		],
	},
];

interface AdditionalFields {
	username?: string;
	password?: string;
}

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const sandboxId = (this.getNodeParameter('sandboxId', itemIndex) as string).trim();
	const path = (this.getNodeParameter('path', itemIndex) as string).trim();
	const additional = this.getNodeParameter('additionalFields', itemIndex, {}) as AdditionalFields;

	const body = omitUndefined({
		path,
		username: additional.username?.trim() || undefined,
		password: additional.password || undefined,
	}) as unknown as IDataObject;

	await daytonaToolboxRequest.call(this, sandboxId, 'POST', TOOLBOX_ENDPOINTS.git.push, body);

	return [
		{
			json: { success: true, sandboxId, path },
			pairedItem: { item: itemIndex },
		},
	];
}
