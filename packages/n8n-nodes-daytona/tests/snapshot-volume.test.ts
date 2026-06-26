/* eslint-disable @n8n/community-nodes/no-restricted-imports, no-console */
import { afterAll, describe, expect, it } from 'vitest';
import { sleep, type ILoadOptionsFunctions } from 'n8n-workflow';

import * as snapshotCreate from '../nodes/Daytona/actions/snapshot/create.operation';
import * as snapshotDelete from '../nodes/Daytona/actions/snapshot/delete.operation';
import * as snapshotGet from '../nodes/Daytona/actions/snapshot/get.operation';
import * as snapshotGetMany from '../nodes/Daytona/actions/snapshot/getMany.operation';
import * as volumeCreate from '../nodes/Daytona/actions/volume/create.operation';
import * as volumeDelete from '../nodes/Daytona/actions/volume/delete.operation';
import * as volumeGet from '../nodes/Daytona/actions/volume/get.operation';
import * as volumeGetMany from '../nodes/Daytona/actions/volume/getMany.operation';
import { getSnapshots } from '../nodes/Daytona/methods/loadOptions';

import { createMockExecuteContext } from './helpers/mock-execute';
import { getTestCredentials, shouldRunIntegration } from './helpers/test-config';

const credentials = getTestCredentials();

describe.skipIf(!shouldRunIntegration())('Snapshot resource', () => {
	const state: { snapshotId?: string; snapshotName?: string } = {};

	afterAll(async () => {
		if (!state.snapshotId || !credentials) return;
		try {
			const ctx = createMockExecuteContext({
				credentials,
				parameters: { snapshotId: state.snapshotId },
			});
			await snapshotDelete.execute.call(ctx, 0);
		} catch (err) {
			console.warn(`[snapshot afterAll] cleanup failed for ${state.snapshotId}:`, err);
		}
	});

	it('Snapshot.GetMany — list returns array', async () => {
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { returnAll: false, limit: 50, filters: {} },
		});
		const result = await snapshotGetMany.execute.call(ctx, 0);
		expect(Array.isArray(result)).toBe(true);
	});

	it('Snapshot.Create — minimal create', async () => {
		const name = `n8n-test-snap-${Date.now()}`;
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				name,
				imageName: 'alpine:3.18',
				additionalFields: {},
			},
		});
		const out = (await snapshotCreate.execute.call(ctx, 0))[0].json as Record<string, unknown>;
		expect(out.name).toBe(name);
		expect(out.id).toBeTypeOf('string');
		state.snapshotName = name;
		state.snapshotId = out.id as string;
	});

	it('Snapshot.Get — retrieve by name (Get accepts name or UUID)', async () => {
		expect(state.snapshotName).toBeDefined();
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { snapshotId: state.snapshotName },
		});
		const out = (await snapshotGet.execute.call(ctx, 0))[0].json as Record<string, unknown>;
		expect(out.name).toBe(state.snapshotName);
	});

	it('loadOptions.getSnapshots — returns dropdown options', async () => {
		const ctx = {
			getCredentials: async () => credentials!,
			getNode: () => ({ name: 'Test' }),
			helpers: createMockExecuteContext({
				credentials: credentials!,
				parameters: {},
			}).helpers,
		} as unknown as ILoadOptionsFunctions;
		const options = await getSnapshots.call(ctx);
		expect(Array.isArray(options)).toBe(true);
		expect(options.length).toBeGreaterThan(0);
		expect(options[0]).toMatchObject({ name: '(Use Daytona Default)', value: '' });
	});

	it('Snapshot.Delete — explicit cleanup by UUID (Activate/Deactivate/Delete require UUID, not name)', async () => {
		expect(state.snapshotId).toBeDefined();
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { snapshotId: state.snapshotId },
		});
		const out = (await snapshotDelete.execute.call(ctx, 0))[0].json as Record<string, unknown>;
		expect(out.success).toBe(true);
		state.snapshotId = undefined;
	});
});

describe.skipIf(!shouldRunIntegration())('Volume resource', () => {
	const state: { volumeId?: string } = {};

	afterAll(async () => {
		if (!state.volumeId || !credentials) return;
		try {
			const ctx = createMockExecuteContext({
				credentials,
				parameters: { volumeId: state.volumeId },
			});
			await volumeDelete.execute.call(ctx, 0);
		} catch (err) {
			console.warn(`[volume afterAll] cleanup failed for ${state.volumeId}:`, err);
		}
	});

	it('Volume.GetMany — list returns array', async () => {
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { returnAll: false, limit: 50, includeDeleted: false },
		});
		const result = await volumeGetMany.execute.call(ctx, 0);
		expect(Array.isArray(result)).toBe(true);
	});

	it('Volume.Create — minimal create', async () => {
		const name = `n8n-test-vol-${Date.now()}`;
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { name },
		});
		const out = (await volumeCreate.execute.call(ctx, 0))[0].json as Record<string, unknown>;
		expect(out.id).toBeTypeOf('string');
		state.volumeId = (out.id as string) || (out.name as string);
	});

	it('Volume.Get — retrieve the volume we just created', async () => {
		expect(state.volumeId).toBeDefined();
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { volumeId: state.volumeId },
		});
		const out = (await volumeGet.execute.call(ctx, 0))[0].json as Record<string, unknown>;
		expect(out.id).toBeTruthy();
	});

	it('Volume.Delete — wait for ready state then delete (Daytona requires ready/error)', async () => {
		expect(state.volumeId).toBeDefined();

		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			const getCtx = createMockExecuteContext({
				credentials: credentials!,
				parameters: { volumeId: state.volumeId },
			});
			const v = (await volumeGet.execute.call(getCtx, 0))[0].json as Record<string, unknown>;
			if (v.state === 'ready' || v.state === 'error') break;
			await sleep(2000);
		}

		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { volumeId: state.volumeId },
		});
		const out = (await volumeDelete.execute.call(ctx, 0))[0].json as Record<string, unknown>;
		expect(out.success).toBe(true);
		state.volumeId = undefined;
	});
});
