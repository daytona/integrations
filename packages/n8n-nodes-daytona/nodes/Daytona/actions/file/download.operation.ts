import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { daytonaToolboxDownloadFile } from '../../helpers/transport';

const showOnly = { resource: ['file'], operation: ['download'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Sandbox ID',
		name: 'sandboxId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID of the sandbox to download the file from',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Remote Path',
		name: 'remotePath',
		type: 'string',
		required: true,
		default: '',
		placeholder: '/home/daytona/file.txt',
		description: 'Absolute path inside the sandbox to read the file from',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Output Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		default: 'data',
		description:
			'Name of the binary field on the output item to attach the downloaded file to',
		displayOptions: { show: showOnly },
	},
];

function deriveFileName(remotePath: string, contentDisposition?: string): string {
	if (contentDisposition) {
		const match = /filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i.exec(contentDisposition);
		if (match?.[1]) {
			try {
				return decodeURIComponent(match[1]);
			} catch {
				return match[1];
			}
		}
	}
	const fromPath = remotePath.split('/').pop()?.trim();
	return fromPath && fromPath.length > 0 ? fromPath : 'download';
}

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const sandboxId = (this.getNodeParameter('sandboxId', itemIndex) as string).trim();
	const remotePath = (this.getNodeParameter('remotePath', itemIndex) as string).trim();
	const binaryPropertyName = this.getNodeParameter('binaryPropertyName', itemIndex, 'data') as string;

	const result = await daytonaToolboxDownloadFile.call(this, sandboxId, remotePath);
	const filename = deriveFileName(remotePath, result.headers['content-disposition'] as string | undefined);

	const binaryData = await this.helpers.prepareBinaryData(result.buffer, filename, result.mimeType);

	return [
		{
			json: {
				success: true,
				sandboxId,
				remotePath,
				fileName: filename,
				mimeType: result.mimeType,
				sizeBytes: result.buffer.length,
			},
			binary: {
				[binaryPropertyName]: binaryData,
			},
			pairedItem: { item: itemIndex },
		},
	];
}
