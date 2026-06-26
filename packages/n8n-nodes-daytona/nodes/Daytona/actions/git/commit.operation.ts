import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { TOOLBOX_ENDPOINTS } from '../../helpers/constants';
import { daytonaToolboxRequest } from '../../helpers/transport';
import { omitUndefined } from '../../helpers/utils';

const showOnly = { resource: ['git'], operation: ['commit'] };

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
		displayName: 'Message',
		name: 'message',
		type: 'string',
		required: true,
		default: '',
		typeOptions: { rows: 3 },
		placeholder: 'feat: add new feature',
		description: 'Commit message',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Author',
		name: 'author',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'Jane Doe',
		description: 'Author name to record in the commit',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Email',
		name: 'email',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'jane@example.com',
		description: 'Author email to record in the commit',
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
				displayName: 'Allow Empty Commit',
				name: 'allowEmpty',
				type: 'boolean',
				default: false,
				description:
					'Whether to create a commit even when no files are staged (useful for re-triggering CI)',
			},
		],
	},
];

interface AdditionalFields {
	allowEmpty?: boolean;
}

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const sandboxId = (this.getNodeParameter('sandboxId', itemIndex) as string).trim();
	const path = (this.getNodeParameter('path', itemIndex) as string).trim();
	const message = (this.getNodeParameter('message', itemIndex) as string).trim();
	const author = (this.getNodeParameter('author', itemIndex) as string).trim();
	const email = (this.getNodeParameter('email', itemIndex) as string).trim();
	const additional = this.getNodeParameter('additionalFields', itemIndex, {}) as AdditionalFields;

	const body = omitUndefined({
		path,
		message,
		author,
		email,
		allow_empty: additional.allowEmpty || undefined,
	}) as unknown as IDataObject;

	const response = (await daytonaToolboxRequest.call(
		this,
		sandboxId,
		'POST',
		TOOLBOX_ENDPOINTS.git.commit,
		body,
	)) as { hash?: string } | undefined;

	return [
		{
			json: {
				success: true,
				sandboxId,
				path,
				hash: response?.hash,
				message,
				author,
				email,
			},
			pairedItem: { item: itemIndex },
		},
	];
}
