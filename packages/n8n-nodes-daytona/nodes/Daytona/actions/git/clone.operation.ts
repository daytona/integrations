import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { TOOLBOX_ENDPOINTS } from '../../helpers/constants';
import { daytonaToolboxRequest } from '../../helpers/transport';
import { omitUndefined } from '../../helpers/utils';

const showOnly = { resource: ['git'], operation: ['clone'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Sandbox ID',
		name: 'sandboxId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID of the sandbox to clone the repository into',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Repository URL',
		name: 'repositoryUrl',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'https://github.com/owner/repo.git',
		description: 'Git repository URL to clone',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Path',
		name: 'path',
		type: 'string',
		required: true,
		default: '',
		placeholder: '/home/daytona/repo',
		description:
			'Absolute path inside the sandbox to clone into. Sandboxes run as the non-root `daytona` user; pick a path under `/home/daytona/` (writable) or `/tmp/` to avoid permission errors.',
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
				displayName: 'Branch',
				name: 'branch',
				type: 'string',
				default: '',
				placeholder: 'main',
				description: 'Branch to check out after cloning. Leave empty for the default branch.',
			},
			{
				displayName: 'Commit ID',
				name: 'commitId',
				type: 'string',
				default: '',
				description: 'Specific commit SHA to check out. Overrides branch if set.',
			},
			{
				displayName: 'Username',
				name: 'username',
				type: 'string',
				default: '',
				description: 'HTTPS username for private repositories',
			},
			{
				displayName: 'Password',
				name: 'password',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				description:
					'HTTPS password or personal access token for private repositories',
			},
		],
	},
];

interface AdditionalFields {
	branch?: string;
	commitId?: string;
	username?: string;
	password?: string;
}

/**
 * Strip embedded HTTPS credentials (`https://user:token@host/…`) from a URL
 * before echoing it back in the node output, so tokens don't leak into the
 * execution data. Falls back to a regex for URLs the WHATWG parser rejects.
 */
function redactUrlCredentials(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		if (url.username || url.password) {
			url.username = '';
			url.password = '';
		}
		return url.toString();
	} catch {
		return rawUrl.replace(/\/\/[^/@]+@/, '//');
	}
}

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const sandboxId = (this.getNodeParameter('sandboxId', itemIndex) as string).trim();
	const repositoryUrl = (this.getNodeParameter('repositoryUrl', itemIndex) as string).trim();
	const path = (this.getNodeParameter('path', itemIndex) as string).trim();
	const additional = this.getNodeParameter('additionalFields', itemIndex, {}) as AdditionalFields;

	const commitId = additional.commitId?.trim() || undefined;
	// A commit SHA fully determines the checkout, so the branch is ignored when a
	// commit is given (matches the field help text). Only send branch otherwise.
	const branch = commitId ? undefined : additional.branch?.trim() || undefined;

	const body = omitUndefined({
		url: repositoryUrl,
		path,
		branch,
		commit_id: commitId,
		username: additional.username?.trim() || undefined,
		password: additional.password || undefined,
	}) as unknown as IDataObject;

	await daytonaToolboxRequest.call(this, sandboxId, 'POST', TOOLBOX_ENDPOINTS.git.clone, body);

	return [
		{
			json: {
				success: true,
				sandboxId,
				repositoryUrl: redactUrlCredentials(repositoryUrl),
				path,
				branch,
				commitId,
			},
			pairedItem: { item: itemIndex },
		},
	];
}
