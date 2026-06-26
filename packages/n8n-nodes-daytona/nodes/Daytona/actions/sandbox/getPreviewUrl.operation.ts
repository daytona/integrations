import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { API_ENDPOINTS } from '../../helpers/constants';
import { daytonaApiRequest } from '../../helpers/transport';
import type { PreviewUrlResponse, SignedPreviewUrlResponse } from '../../helpers/types';

const showOnly = { resource: ['sandbox'], operation: ['getPreviewUrl'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Sandbox ID',
		name: 'sandboxId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID of the sandbox to generate the preview URL for',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Port',
		name: 'port',
		type: 'number',
		required: true,
		default: 3000,
		typeOptions: { minValue: 1, maxValue: 65535 },
		description: 'Port inside the sandbox to expose',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'URL Type',
		name: 'urlType',
		type: 'options',
		default: 'signed',
		description:
			'Signed URLs embed the auth token directly in the URL (no header needed). Standard URLs return the token separately and require sending it via the <code>x-daytona-preview-token</code> header.',
		options: [
			{
				name: 'Signed',
				value: 'signed',
				description: 'Token embedded in URL (simpler — works in browsers)',
			},
			{
				name: 'Standard',
				value: 'standard',
				description: 'Token returned separately; must be sent via x-daytona-preview-token header',
			},
		],
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Expires In (Seconds)',
		name: 'expiresInSeconds',
		type: 'number',
		default: 3600,
		typeOptions: { minValue: 1, maxValue: 604800 },
		description: 'How long the signed URL is valid (max 7 days)',
		displayOptions: { show: { ...showOnly, urlType: ['signed'] } },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const sandboxId = (this.getNodeParameter('sandboxId', itemIndex) as string).trim();
	const port = this.getNodeParameter('port', itemIndex) as number;
	const urlType = this.getNodeParameter('urlType', itemIndex, 'signed') as 'signed' | 'standard';

	if (urlType === 'signed') {
		const expiresInSeconds = this.getNodeParameter(
			'expiresInSeconds',
			itemIndex,
			3600,
		) as number;
		const response = (await daytonaApiRequest.call(
			this,
			'GET',
			API_ENDPOINTS.sandbox.signedPreviewUrl(sandboxId, port),
			undefined,
			{ expiresInSeconds },
		)) as SignedPreviewUrlResponse;

		return [
			{
				json: {
					...response,
					sandboxId,
					port,
					urlType: 'signed',
				} as unknown as IDataObject,
				pairedItem: { item: itemIndex },
			},
		];
	}

	const response = (await daytonaApiRequest.call(
		this,
		'GET',
		API_ENDPOINTS.sandbox.previewUrl(sandboxId, port),
	)) as PreviewUrlResponse;

	return [
		{
			json: {
				...response,
				sandboxId,
				port,
				urlType: 'standard',
			} as unknown as IDataObject,
			pairedItem: { item: itemIndex },
		},
	];
}
