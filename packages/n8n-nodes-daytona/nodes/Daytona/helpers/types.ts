export type SandboxState =
	| 'creating'
	| 'starting'
	| 'started'
	| 'stopping'
	| 'stopped'
	| 'archiving'
	| 'archived'
	| 'destroying'
	| 'destroyed'
	| 'pulling_snapshot'
	| 'restoring'
	| 'error'
	| 'unknown';

export interface SandboxVolumeMount {
	volumeId: string;
	mountPath: string;
	subpath?: string;
}

export interface Sandbox {
	id: string;
	name?: string;
	state: SandboxState;
	target?: string;
	cpu?: number;
	memory?: number;
	disk?: number;
	user?: string;
	env?: Record<string, string>;
	labels?: Record<string, string>;
	public?: boolean;
	toolboxProxyUrl?: string;
	autoStopInterval?: number;
	autoArchiveInterval?: number;
	autoDeleteInterval?: number;
	volumes?: SandboxVolumeMount[];
	networkBlockAll?: boolean;
	networkAllowList?: string;
	createdAt?: string;
	updatedAt?: string;
	[k: string]: unknown;
}

export interface CreateSandboxRequest {
	name?: string;
	snapshot?: string;
	buildInfo?: {
		dockerfileContent?: string;
		[k: string]: unknown;
	};
	user?: string;
	env?: Record<string, string>;
	labels?: Record<string, string>;
	public?: boolean;
	target?: string;
	cpu?: number;
	memory?: number;
	disk?: number;
	autoStopInterval?: number;
	autoArchiveInterval?: number;
	autoDeleteInterval?: number;
	volumes?: SandboxVolumeMount[];
	networkBlockAll?: boolean;
	networkAllowList?: string;
}

export interface ProcessExecutionResponse {
	exitCode: number;
	result: string;
	artifacts?: {
		stdout?: string;
		charts?: Array<Record<string, unknown>>;
	};
}

export interface PreviewUrlResponse {
	url: string;
	token: string;
	port: number;
	legacyProxyUrl?: string;
}

export interface SignedPreviewUrlResponse {
	url: string;
	port: number;
	expiresAt?: string;
}

export interface PaginatedResponse<T> {
	items: T[];
	page?: number;
	pageSize?: number;
	total?: number;
	totalPages?: number;
	hasMore?: boolean;
}

export interface CursorPaginatedResponse<T> {
	items: T[];
	nextCursor: string | null;
}

export type SnapshotState =
	| 'creating'
	| 'pending'
	| 'building'
	| 'active'
	| 'inactive'
	| 'destroyed'
	| 'error'
	| 'unknown';

export interface Snapshot {
	id: string;
	name?: string;
	state?: SnapshotState;
	imageName?: string;
	general?: boolean;
	cpu?: number;
	memory?: number;
	disk?: number;
	regionId?: string;
	entrypoint?: string[];
	createdAt?: string;
	updatedAt?: string;
	lastUsedAt?: string;
	[k: string]: unknown;
}

export interface CreateSnapshotRequest {
	name: string;
	imageName?: string;
	cpu?: number;
	memory?: number;
	disk?: number;
	regionId?: string;
	entrypoint?: string[];
}

export interface Volume {
	id: string;
	name?: string;
	state?: string;
	deleted?: boolean;
	createdAt?: string;
	updatedAt?: string;
	[k: string]: unknown;
}

export interface CreateVolumeRequest {
	name: string;
}
