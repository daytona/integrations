import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

import { daytonaToolboxUploadFile } from '../../helpers/transport';

const showOnly = { resource: ['file'], operation: ['upload'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Sandbox ID',
		name: 'sandboxId',
		type: 'string',
		required: true,
		default: '',
		description: 'ID of the sandbox to upload the file into',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Remote Path',
		name: 'remotePath',
		type: 'string',
		required: true,
		default: '',
		placeholder: '/home/daytona/file.txt',
		description:
			'Absolute path inside the sandbox where the file should be written. Sandboxes run as the non-root `daytona` user; pick a path under `/home/daytona/` (writable) or `/tmp/` to avoid permission errors.',
		displayOptions: { show: showOnly },
	},
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		default: 'data',
		description:
			'Name of the binary field on the input item containing the file to upload (e.g. "data" from a previous HTTP Request or Read Binary File node)',
		displayOptions: { show: showOnly },
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const sandboxId = (this.getNodeParameter('sandboxId', itemIndex) as string).trim();
	const remotePath = (this.getNodeParameter('remotePath', itemIndex) as string).trim();
	const binaryPropertyName = this.getNodeParameter('binaryPropertyName', itemIndex, 'data') as string;

	const binaryMeta = this.helpers.assertBinaryData(itemIndex, binaryPropertyName);
	const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, binaryPropertyName);

	const filename =
		binaryMeta.fileName?.trim() ||
		remotePath.split('/').pop()?.trim() ||
		'upload';
	const mimeType = binaryMeta.mimeType?.trim() || 'application/octet-stream';

	await daytonaToolboxUploadFile.call(this, sandboxId, remotePath, {
		buffer,
		filename,
		mimeType,
	});

	return [
		{
			json: {
				success: true,
				sandboxId,
				remotePath,
				fileName: filename,
				mimeType,
				sizeBytes: buffer.length,
			},
			pairedItem: { item: itemIndex },
		},
	];
}
