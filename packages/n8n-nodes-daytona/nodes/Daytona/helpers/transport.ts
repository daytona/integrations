import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, sleep } from 'n8n-workflow';

import {
	CREDENTIAL_TYPE,
	DEFAULT_BASE_URL,
	API_ENDPOINTS,
	SANDBOX_READY_POLL,
	SNAPSHOT_READY_POLL,
	TOOLBOX_ENDPOINTS,
} from './constants';
import type {
	CreateSandboxRequest,
	Sandbox,
	SandboxState,
	Snapshot,
	SnapshotState,
} from './types';
import { omitUndefined } from './utils';

type RequestContext = IExecuteFunctions | ILoadOptionsFunctions;

const toolboxUrlCacheByContext = new WeakMap<object, Map<string, string>>();

function getToolboxCache(ctx: IExecuteFunctions): Map<string, string> {
	let cache = toolboxUrlCacheByContext.get(ctx);
	if (!cache) {
		cache = new Map();
		toolboxUrlCacheByContext.set(ctx, cache);
	}
	return cache;
}

async function resolveBaseUrl(ctx: RequestContext): Promise<string> {
	const credentials = await ctx.getCredentials(CREDENTIAL_TYPE);
	const raw = (credentials.baseUrl as string | undefined)?.trim();
	const baseUrl = raw && raw.length > 0 ? raw : DEFAULT_BASE_URL;
	return baseUrl.replace(/\/+$/, '');
}

export async function daytonaApiRequest(
	this: RequestContext,
	method: IHttpRequestMethods,
	endpoint: string,
	body?: IDataObject | Buffer,
	qs: IDataObject = {},
	additionalOptions: Partial<IHttpRequestOptions> = {},
): Promise<unknown> {
	const baseUrl = await resolveBaseUrl(this);

	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${endpoint}`,
		qs,
		json: true,
		...additionalOptions,
	};
	if (body !== undefined) {
		options.body = body;
	}

	try {
		return await this.helpers.httpRequestWithAuthentication.call(
			this,
			CREDENTIAL_TYPE,
			options,
		);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}

export async function getToolboxBase(
	this: IExecuteFunctions,
	sandboxId: string,
): Promise<string> {
	const cache = getToolboxCache(this);
	const cached = cache.get(sandboxId);
	if (cached) return cached;

	const sandbox = (await daytonaApiRequest.call(
		this,
		'GET',
		API_ENDPOINTS.sandbox.get(sandboxId),
	)) as Sandbox;

	if (!sandbox?.toolboxProxyUrl) {
		throw new NodeApiError(this.getNode(), {
			message: `Sandbox "${sandboxId}" has no toolboxProxyUrl. Current state: ${
				sandbox?.state ?? 'unknown'
			}. The sandbox may not be started yet.`,
		});
	}

	const trimmed = sandbox.toolboxProxyUrl.replace(/\/+$/, '');
	cache.set(sandboxId, trimmed);
	return trimmed;
}

export async function daytonaToolboxRequest(
	this: IExecuteFunctions,
	sandboxId: string,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject | Buffer,
	qs: IDataObject = {},
	additionalOptions: Partial<IHttpRequestOptions> = {},
): Promise<unknown> {
	const toolboxBase = await getToolboxBase.call(this, sandboxId);
	const url = `${toolboxBase}/${encodeURIComponent(sandboxId)}${path}`;

	const options: IHttpRequestOptions = {
		method,
		url,
		qs,
		json: true,
		...additionalOptions,
	};
	if (body !== undefined) {
		options.body = body;
	}

	try {
		return await this.helpers.httpRequestWithAuthentication.call(
			this,
			CREDENTIAL_TYPE,
			options,
		);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}

export function invalidateToolboxCache(ctx: IExecuteFunctions, sandboxId?: string): void {
	const cache = toolboxUrlCacheByContext.get(ctx);
	if (!cache) return;
	if (sandboxId) {
		cache.delete(sandboxId);
	} else {
		cache.clear();
	}
}

export interface WaitForSandboxStateOptions {
	targetStates: SandboxState[];
	failOnStates?: SandboxState[];
	timeoutMs?: number;
	intervalMs?: number;
}

export async function waitForSandboxState(
	this: IExecuteFunctions,
	sandboxId: string,
	options: WaitForSandboxStateOptions,
): Promise<Sandbox> {
	const targets = new Set<SandboxState>(options.targetStates);
	const failures = new Set<SandboxState>(options.failOnStates ?? ['error']);
	const timeoutMs = options.timeoutMs ?? SANDBOX_READY_POLL.timeoutMs;
	const intervalMs = options.intervalMs ?? SANDBOX_READY_POLL.intervalMs;
	const start = Date.now();

	let lastState: SandboxState = 'unknown';
	while (Date.now() - start <= timeoutMs) {
		const sandbox = (await daytonaApiRequest.call(
			this,
			'GET',
			API_ENDPOINTS.sandbox.get(sandboxId),
		)) as Sandbox;
		lastState = sandbox.state;

		if (targets.has(sandbox.state)) return sandbox;
		if (failures.has(sandbox.state)) {
			throw new NodeApiError(this.getNode(), {
				message: `Sandbox "${sandboxId}" entered failure state "${sandbox.state}".`,
			});
		}

		await sleep(intervalMs);
	}

	throw new NodeApiError(this.getNode(), {
		message: `Timed out after ${timeoutMs}ms waiting for sandbox "${sandboxId}" to reach state(s) [${[...targets].join(', ')}]. Last observed state: "${lastState}".`,
	});
}

export interface WaitForSnapshotStateOptions {
	targetStates: SnapshotState[];
	failOnStates?: SnapshotState[];
	timeoutMs?: number;
	intervalMs?: number;
}

export async function waitForSnapshotState(
	this: IExecuteFunctions,
	snapshotIdOrName: string,
	options: WaitForSnapshotStateOptions,
): Promise<Snapshot> {
	const targets = new Set<SnapshotState>(options.targetStates);
	const failures = new Set<SnapshotState>(options.failOnStates ?? ['error']);
	const timeoutMs = options.timeoutMs ?? SNAPSHOT_READY_POLL.timeoutMs;
	const intervalMs = options.intervalMs ?? SNAPSHOT_READY_POLL.intervalMs;
	const start = Date.now();

	let lastState: SnapshotState | undefined;
	while (Date.now() - start <= timeoutMs) {
		const snapshot = (await daytonaApiRequest.call(
			this,
			'GET',
			API_ENDPOINTS.snapshot.get(snapshotIdOrName),
		)) as Snapshot;
		lastState = snapshot.state;

		if (lastState && targets.has(lastState)) return snapshot;
		if (lastState && failures.has(lastState)) {
			throw new NodeApiError(this.getNode(), {
				message: `Snapshot "${snapshotIdOrName}" entered failure state "${lastState}".`,
			});
		}

		await sleep(intervalMs);
	}

	throw new NodeApiError(this.getNode(), {
		message: `Timed out after ${timeoutMs}ms waiting for snapshot "${snapshotIdOrName}" to reach state(s) [${[...targets].join(', ')}]. Last observed state: "${lastState ?? 'unknown'}".`,
	});
}

export interface CreateEphemeralOptions {
	snapshot?: string;
	envVars?: Record<string, string>;
	waitTimeoutMs?: number;
	additionalCreateFields?: Partial<CreateSandboxRequest>;
}

export async function createEphemeralSandbox(
	this: IExecuteFunctions,
	options: CreateEphemeralOptions = {},
): Promise<Sandbox> {
	const body = omitUndefined({
		snapshot: options.snapshot || undefined,
		env: options.envVars,
		...options.additionalCreateFields,
		autoDeleteInterval: 0,
	}) as unknown as IDataObject;

	const created = (await daytonaApiRequest.call(
		this,
		'POST',
		API_ENDPOINTS.sandbox.create,
		body,
	)) as Sandbox;

	if (created.state === 'started') return created;

	return waitForSandboxState.call(this, created.id, {
		targetStates: ['started'],
		timeoutMs: options.waitTimeoutMs ?? SANDBOX_READY_POLL.timeoutMs,
	});
}

export async function safeDeleteSandbox(
	this: IExecuteFunctions,
	sandboxId: string,
): Promise<{ deleted: boolean; error?: string }> {
	try {
		await daytonaApiRequest.call(this, 'DELETE', API_ENDPOINTS.sandbox.delete(sandboxId));
		invalidateToolboxCache(this, sandboxId);
		return { deleted: true };
	} catch (error) {
		invalidateToolboxCache(this, sandboxId);
		return {
			deleted: false,
			error: (error as Error).message,
		};
	}
}

export interface UploadFileInput {
	buffer: Buffer;
	filename: string;
	mimeType: string;
}

export async function daytonaToolboxUploadFile(
	this: IExecuteFunctions,
	sandboxId: string,
	remotePath: string,
	file: UploadFileInput,
): Promise<unknown> {
	const toolboxBase = await getToolboxBase.call(this, sandboxId);
	const url = `${toolboxBase}/${encodeURIComponent(sandboxId)}${TOOLBOX_ENDPOINTS.files.upload}`;

	const formData = new FormData();
	formData.append(
		'file',
		new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }),
		file.filename,
	);

	try {
		return await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL_TYPE, {
			method: 'POST',
			url,
			qs: { path: remotePath },
			body: formData,
		});
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}

export interface DownloadFileResult {
	buffer: Buffer;
	mimeType: string;
	headers: IDataObject;
}

export async function daytonaToolboxDownloadFile(
	this: IExecuteFunctions,
	sandboxId: string,
	remotePath: string,
): Promise<DownloadFileResult> {
	const toolboxBase = await getToolboxBase.call(this, sandboxId);
	const url = `${toolboxBase}/${encodeURIComponent(sandboxId)}${TOOLBOX_ENDPOINTS.files.download}`;

	try {
		const response = (await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL_TYPE, {
			method: 'GET',
			url,
			qs: { path: remotePath },
			encoding: 'arraybuffer',
			returnFullResponse: true,
		})) as { body: ArrayBuffer | Buffer; headers: IDataObject };

		const buffer = Buffer.isBuffer(response.body)
			? response.body
			: Buffer.from(response.body as ArrayBuffer);

		const contentType =
			(response.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
		return {
			buffer,
			mimeType: contentType.split(';')[0].trim(),
			headers: response.headers,
		};
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}
