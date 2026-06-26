export const CREDENTIAL_TYPE = 'daytonaApi';

export const DEFAULT_BASE_URL = 'https://app.daytona.io/api';

export const API_ENDPOINTS = {
	sandbox: {
		create: '/sandbox',
		list: '/sandbox',
		get: (id: string) => `/sandbox/${encodeURIComponent(id)}`,
		delete: (id: string) => `/sandbox/${encodeURIComponent(id)}`,
		start: (id: string) => `/sandbox/${encodeURIComponent(id)}/start`,
		stop: (id: string) => `/sandbox/${encodeURIComponent(id)}/stop`,
		previewUrl: (id: string, port: number) =>
			`/sandbox/${encodeURIComponent(id)}/ports/${port}/preview-url`,
		signedPreviewUrl: (id: string, port: number) =>
			`/sandbox/${encodeURIComponent(id)}/ports/${port}/signed-preview-url`,
	},
	apiKeys: {
		current: '/api-keys/current',
	},
	snapshot: {
		create: '/snapshots',
		list: '/snapshots',
		get: (id: string) => `/snapshots/${encodeURIComponent(id)}`,
		delete: (id: string) => `/snapshots/${encodeURIComponent(id)}`,
		activate: (id: string) => `/snapshots/${encodeURIComponent(id)}/activate`,
		deactivate: (id: string) => `/snapshots/${encodeURIComponent(id)}/deactivate`,
	},
	volume: {
		create: '/volumes',
		list: '/volumes',
		get: (id: string) => `/volumes/${encodeURIComponent(id)}`,
		delete: (id: string) => `/volumes/${encodeURIComponent(id)}`,
	},
};

/**
 * Toolbox endpoints are appended to a per-sandbox base URL composed as:
 *   `{toolboxProxyUrl}/{sandboxId}{path}`
 *
 * The `toolboxProxyUrl` value returned by `GET /sandbox/{id}` ALREADY
 * includes the `/toolbox` segment — do NOT prepend it again. See
 * helpers/transport.ts (`getToolboxBase`, `daytonaToolboxRequest`) for
 * the composition logic.
 */
export const TOOLBOX_ENDPOINTS = {
	process: {
		runCode: '/process/code-run',
		execute: '/process/execute',
	},
	files: {
		upload: '/files/upload',
		download: '/files/download',
		info: '/files/info',
		list: '/files',
		delete: '/files',
		folder: '/files/folder',
		move: '/files/move',
	},
	git: {
		clone: '/git/clone',
		status: '/git/status',
		add: '/git/add',
		commit: '/git/commit',
		push: '/git/push',
		pull: '/git/pull',
		checkout: '/git/checkout',
	},
};

/**
 * Default polling configuration for waiting on a sandbox to reach a target state
 * (e.g. after Create or Start). Used by Sandbox.Create and ephemeral Code ops.
 */
export const SANDBOX_READY_POLL = {
	intervalMs: 1000,
	timeoutMs: 60_000,
};

/**
 * Default polling configuration for waiting on a snapshot to reach a target state
 * (e.g. active after Create/Activate, inactive after Deactivate). Snapshot creation
 * involves pulling and building from a Docker image so the timeout is longer than
 * for sandboxes.
 */
export const SNAPSHOT_READY_POLL = {
	intervalMs: 2000,
	timeoutMs: 600_000,
};
