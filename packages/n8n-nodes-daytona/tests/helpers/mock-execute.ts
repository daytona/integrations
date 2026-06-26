import type {
	IBinaryData,
	IBinaryKeyData,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INode,
	INodeExecutionData,
} from 'n8n-workflow';

import type { DaytonaTestCredentials } from './test-config';

interface IRequestOptionsLike {
	url?: string;
	uri?: string;
	baseURL?: string;
	method?: string;
	headers?: Record<string, string>;
	qs?: IDataObject;
	body?: unknown;
	formData?: Record<string, unknown>;
	encoding?: string | null;
	returnFullResponse?: boolean;
}

interface MockOptions {
	parameters: Record<string, unknown>;
	credentials: DaytonaTestCredentials;
	inputBinary?: IBinaryKeyData;
	continueOnFail?: boolean;
}

const TEST_NODE: INode = {
	id: 'test-node',
	name: 'TestDaytona',
	type: '@daytona/n8n-nodes-daytona.daytona',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

function applyAuth(
	options: IHttpRequestOptions | IRequestOptionsLike,
	credentials: DaytonaTestCredentials,
): { url: string; headers: Record<string, string>; body?: BodyInit | null } {
	const baseUrl = (options.baseURL ?? '').toString().replace(/\/+$/, '');
	const path = (options.url ?? (options as IRequestOptionsLike).uri ?? '').toString();
	const fullUrl = path.startsWith('http') ? path : `${baseUrl}${path}`;

	const qs = options.qs as IDataObject | undefined;
	const search = qs
		? '?' +
			Object.entries(qs)
				.filter(([, v]) => v !== undefined && v !== null && v !== '')
				.map(
					([k, v]) =>
						`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
				)
				.join('&')
		: '';

	const headers: Record<string, string> = {
		Accept: 'application/json',
		Authorization: `Bearer ${credentials.apiKey}`,
		...((options.headers ?? {}) as Record<string, string>),
	};
	if (credentials.organizationId) {
		headers['X-Daytona-Organization-ID'] = credentials.organizationId;
	}

	let body: BodyInit | null | undefined;
	if (options.body !== undefined && options.body !== null) {
		if (options.body instanceof FormData) {
			body = options.body;
			delete headers['Content-Type'];
		} else if (Buffer.isBuffer(options.body)) {
			body = options.body as unknown as BodyInit;
		} else if (typeof options.body === 'string') {
			body = options.body;
		} else {
			body = JSON.stringify(options.body);
			if (!headers['Content-Type'] && !headers['content-type']) {
				headers['Content-Type'] = 'application/json';
			}
		}
	}

	const formData = (options as IRequestOptionsLike).formData;
	if (formData) {
		const fd = new FormData();
		for (const [key, value] of Object.entries(formData)) {
			if (
				typeof value === 'object' &&
				value !== null &&
				'value' in (value as Record<string, unknown>)
			) {
				const entry = value as {
					value: Buffer | string;
					options?: { filename?: string; contentType?: string };
				};
				const buf = Buffer.isBuffer(entry.value) ? entry.value : Buffer.from(String(entry.value));
				const blob = new Blob([buf], { type: entry.options?.contentType ?? 'application/octet-stream' });
				fd.append(key, blob, entry.options?.filename ?? 'file');
			} else {
				fd.append(key, String(value));
			}
		}
		body = fd;
		delete headers['Content-Type'];
	}

	return { url: fullUrl + search, headers, body };
}

async function executeRequest(
	options: IHttpRequestOptions,
	credentials: DaytonaTestCredentials,
): Promise<unknown> {
	const { url, headers, body } = applyAuth(options, credentials);

	const response = await fetch(url, {
		method: (options.method ?? 'GET') as string,
		headers,
		body,
	});

	const responseHeaders: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		responseHeaders[key.toLowerCase()] = value;
	});

	let parsedBody: unknown;
	if (options.encoding === 'arraybuffer') {
		parsedBody = await response.arrayBuffer();
	} else {
		const text = await response.text();
		const contentType = responseHeaders['content-type'] ?? '';
		parsedBody = contentType.includes('application/json') && text ? JSON.parse(text) : text;
	}

	if (!response.ok) {
		const errorBody =
			typeof parsedBody === 'string' ? parsedBody : JSON.stringify(parsedBody);
		const error = new Error(
			`HTTP ${response.status} ${response.statusText}: ${errorBody.slice(0, 500)}`,
		);
		(error as unknown as IDataObject).response = {
			statusCode: response.status,
			body: parsedBody,
			headers: responseHeaders,
		};
		throw error;
	}

	if (options.returnFullResponse) {
		return {
			body: parsedBody,
			headers: responseHeaders,
			statusCode: response.status,
		};
	}

	return parsedBody;
}

export function createMockExecuteContext(opts: MockOptions): IExecuteFunctions {
	const inputItem: INodeExecutionData = {
		json: {},
		...(opts.inputBinary ? { binary: opts.inputBinary } : {}),
	};

	const ctx = {
		getNodeParameter: (name: string, _itemIndex: number, defaultValue?: unknown) => {
			const value = opts.parameters[name];
			return value === undefined ? defaultValue : value;
		},
		getCredentials: async () => ({
			apiKey: opts.credentials.apiKey,
			baseUrl: opts.credentials.baseUrl,
			organizationId: opts.credentials.organizationId,
		}),
		getNode: () => TEST_NODE,
		getInputData: () => [inputItem],
		continueOnFail: () => opts.continueOnFail ?? false,
		helpers: {
			httpRequestWithAuthentication: async function (
				_credentialType: string,
				options: IHttpRequestOptions,
			) {
				return executeRequest(options, opts.credentials);
			},
			requestWithAuthentication: async function (
				_credentialType: string,
				options: IRequestOptionsLike,
			) {
				return executeRequest(options as unknown as IHttpRequestOptions, opts.credentials);
			},
			assertBinaryData: (_itemIndex: number, propertyName: string): IBinaryData => {
				if (!inputItem.binary?.[propertyName]) {
					throw new Error(`No binary data on property "${propertyName}"`);
				}
				return inputItem.binary[propertyName];
			},
			getBinaryDataBuffer: async (_itemIndex: number, propertyName: string): Promise<Buffer> => {
				const meta = inputItem.binary?.[propertyName];
				if (!meta) throw new Error(`No binary data on property "${propertyName}"`);
				if (!meta.data) throw new Error(`Binary data on "${propertyName}" has no payload`);
				return Buffer.from(meta.data, 'base64');
			},
			prepareBinaryData: async (
				binaryData: Buffer,
				filePath?: string,
				mimeType?: string,
			): Promise<IBinaryData> => ({
				data: binaryData.toString('base64'),
				mimeType: mimeType ?? 'application/octet-stream',
				fileName: filePath,
				fileExtension: filePath?.includes('.') ? filePath.split('.').pop() : undefined,
			}),
		},
	};

	return ctx as unknown as IExecuteFunctions;
}

export function makeBinaryInput(
	buffer: Buffer,
	fileName: string,
	mimeType: string,
	property = 'data',
): IBinaryKeyData {
	return {
		[property]: {
			data: buffer.toString('base64'),
			mimeType,
			fileName,
			fileExtension: fileName.includes('.') ? fileName.split('.').pop() : undefined,
		},
	};
}
