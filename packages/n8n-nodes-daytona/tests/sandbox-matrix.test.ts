/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/require-node-api-error, no-console */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sleep } from 'n8n-workflow';

import * as sandboxCreate from '../nodes/Daytona/actions/sandbox/create.operation';
import * as sandboxDelete from '../nodes/Daytona/actions/sandbox/delete.operation';
import * as snapshotActivate from '../nodes/Daytona/actions/snapshot/activate.operation';
import * as snapshotGet from '../nodes/Daytona/actions/snapshot/get.operation';
import * as codeRunCommand from '../nodes/Daytona/actions/code/runCommand.operation';
import * as volumeCreate from '../nodes/Daytona/actions/volume/create.operation';
import * as volumeDelete from '../nodes/Daytona/actions/volume/delete.operation';
import * as volumeGet from '../nodes/Daytona/actions/volume/get.operation';

import { createMockExecuteContext } from './helpers/mock-execute';
import {
	getTestCredentials,
	shouldRunCreateMatrix,
	TEST_DEFAULTS,
	TEST_MATRIX_DEFAULTS,
} from './helpers/test-config';

const credentials = getTestCredentials();

describe.skipIf(!shouldRunCreateMatrix())(
	'Sandbox.Create — combinations matrix (opt-in via DAYTONA_TEST_INCLUDE_CREATE_MATRIX=1)',
	() => {
		const created: string[] = [];

		beforeAll(async () => {
			if (!TEST_DEFAULTS.snapshot || !credentials) return;
			try {
				const getCtx = createMockExecuteContext({
					credentials,
					parameters: { snapshotId: TEST_DEFAULTS.snapshot },
				});
				const snap = (await snapshotGet.execute.call(getCtx, 0))[0].json as Record<
					string,
					unknown
				>;
				if (snap.state === 'active') return;
				if (!snap.id) return;
				const activateCtx = createMockExecuteContext({
					credentials,
					parameters: { snapshotId: snap.id },
				});
				await snapshotActivate.execute.call(activateCtx, 0);
				const deadline = Date.now() + 60_000;
				while (Date.now() < deadline) {
					const polled = (await snapshotGet.execute.call(getCtx, 0))[0].json as Record<
						string,
						unknown
					>;
					if (polled.state === 'active') return;
					await sleep(2000);
				}
			} catch (err) {
				console.warn(
					`[beforeAll] Could not activate DAYTONA_TEST_SNAPSHOT="${TEST_DEFAULTS.snapshot}":`,
					err,
				);
			}
		}, 120_000);

		afterEach(async () => {
			for (const id of created.splice(0)) {
				try {
					const ctx = createMockExecuteContext({
						credentials: credentials!,
						parameters: { sandboxId: id },
					});
					await sandboxDelete.execute.call(ctx, 0);
				} catch (err) {
					console.warn(`[matrix afterEach] failed to delete ${id}:`, err);
				}
			}
		});

		it('Snapshot only (no image) — uses Daytona default snapshot', async () => {
			const ctx = createMockExecuteContext({
				credentials: credentials!,
				parameters: {
					snapshot: '',
					image: '',
					name: '',
					ephemeral: false,
					waitUntilStarted: true,
					waitTimeoutSeconds: 90,
					additionalFields: {},
				},
			});
			const out = (await sandboxCreate.execute.call(ctx, 0))[0].json as Record<string, unknown>;
			expect(out.id).toBeTypeOf('string');
			expect(out.state).toBe('started');
			created.push(out.id as string);
		});

		it('Image only (Docker reference)', async () => {
			const ctx = createMockExecuteContext({
				credentials: credentials!,
				parameters: {
					snapshot: '',
					image: TEST_MATRIX_DEFAULTS.image,
					name: '',
					ephemeral: false,
					waitUntilStarted: true,
					waitTimeoutSeconds: 180,
					additionalFields: {},
				},
			});
			const out = (await sandboxCreate.execute.call(ctx, 0))[0].json as Record<string, unknown>;
			expect(out.id).toBeTypeOf('string');
			expect(out.state).toBe('started');
			created.push(out.id as string);
		});

		it.skipIf(!TEST_DEFAULTS.snapshot)(
			'Snapshot + Image both set — Snapshot wins (image is ignored, bogus image does NOT trigger build_failed). REQUIRES DAYTONA_TEST_SNAPSHOT to point at an active snapshot.',
			async (testCtx) => {
				const ctx = createMockExecuteContext({
					credentials: credentials!,
					parameters: {
						snapshot: TEST_DEFAULTS.snapshot ?? '',
						image: 'this-image-should-be-ignored:latest',
						name: '',
						ephemeral: false,
						waitUntilStarted: true,
						waitTimeoutSeconds: 90,
						additionalFields: {},
					},
				});

				let out: Record<string, unknown>;
				try {
					out = (await sandboxCreate.execute.call(ctx, 0))[0].json as Record<string, unknown>;
				} catch (err) {
					const msg = (err as Error).message ?? '';
					const desc = (err as { description?: string }).description ?? '';
					if (msg.includes('inactive') || desc.includes('inactive')) {
						console.warn(
							`[skip] DAYTONA_TEST_SNAPSHOT "${TEST_DEFAULTS.snapshot}" is inactive. Activate it via the Daytona dashboard (or POST /snapshots/${TEST_DEFAULTS.snapshot}/activate) to run this test.`,
						);
						testCtx.skip();
						return;
					}
					throw err;
				}

				expect(out.id).toBeTypeOf('string');
				expect(out.state).toBe('started');
				created.push(out.id as string);
			},
		);

		it('Resources (cpu, memory, disk) with Image — only valid combination per Daytona API', async () => {
			const ctx = createMockExecuteContext({
				credentials: credentials!,
				parameters: {
					snapshot: '',
					image: TEST_MATRIX_DEFAULTS.image,
					name: '',
					ephemeral: false,
					waitUntilStarted: true,
					waitTimeoutSeconds: 240,
					additionalFields: {
						cpu: 1,
						memory: 1,
						disk: 3,
					},
				},
			});
			const out = (await sandboxCreate.execute.call(ctx, 0))[0].json as Record<string, unknown>;
			expect(out.id).toBeTypeOf('string');
			expect(out.state).toBe('started');
			created.push(out.id as string);
		});

		it('Resources + Snapshot — node strips resources client-side; create succeeds (no API 400)', async () => {
			const ctx = createMockExecuteContext({
				credentials: credentials!,
				parameters: {
					snapshot: '',
					image: '',
					name: '',
					ephemeral: false,
					waitUntilStarted: true,
					waitTimeoutSeconds: 90,
					additionalFields: {
						cpu: 4,
						memory: 8,
						disk: 10,
					},
				},
			});
			const out = (await sandboxCreate.execute.call(ctx, 0))[0].json as Record<string, unknown>;
			expect(out.id).toBeTypeOf('string');
			expect(out.state).toBe('started');
			created.push(out.id as string);
		});

		it('Env vars + labels — verified inside the sandbox', async () => {
			const ctx = createMockExecuteContext({
				credentials: credentials!,
				parameters: {
					snapshot: '',
					image: '',
					name: 'n8n-matrix-env-labels',
					ephemeral: false,
					waitUntilStarted: true,
					waitTimeoutSeconds: 90,
					additionalFields: {
						env: {
							entry: [
								{ name: 'N8N_MATRIX_FOO', value: 'bar' },
								{ name: 'N8N_MATRIX_NUMERIC', value: '42' },
							],
						},
						labels: {
							entry: [
								{ name: 'team', value: 'n8n-matrix' },
								{ name: 'purpose', value: 'test' },
							],
						},
					},
				},
			});
			const sandbox = (await sandboxCreate.execute.call(ctx, 0))[0].json as Record<
				string,
				unknown
			>;
			const sandboxId = sandbox.id as string;
			created.push(sandboxId);

			const labels = sandbox.labels as Record<string, string> | undefined;
			expect(labels?.team).toBe('n8n-matrix');
			expect(labels?.purpose).toBe('test');

			const echoCtx = createMockExecuteContext({
				credentials: credentials!,
				parameters: {
					command: 'echo "$N8N_MATRIX_FOO|$N8N_MATRIX_NUMERIC"',
					useEphemeralSandbox: false,
					sandboxId,
					additionalFields: {},
				},
			});
			const echoOut = (await codeRunCommand.execute.call(echoCtx, 0))[0].json as Record<
				string,
				unknown
			>;
			expect(echoOut.exitCode).toBe(0);
			expect(echoOut.result).toContain('bar|42');
		});

		it('Combined: image + resources + env + labels', async () => {
			const ctx = createMockExecuteContext({
				credentials: credentials!,
				parameters: {
					snapshot: '',
					image: TEST_MATRIX_DEFAULTS.image,
					name: 'n8n-matrix-combined',
					ephemeral: false,
					waitUntilStarted: true,
					waitTimeoutSeconds: 240,
					additionalFields: {
						cpu: 1,
						memory: 1,
						env: { entry: [{ name: 'COMBINED_FOO', value: 'baz' }] },
						labels: { entry: [{ name: 'origin', value: 'matrix' }] },
					},
				},
			});
			const sandbox = (await sandboxCreate.execute.call(ctx, 0))[0].json as Record<
				string,
				unknown
			>;
			const sandboxId = sandbox.id as string;
			created.push(sandboxId);
			expect(sandbox.state).toBe('started');

			const verifyCtx = createMockExecuteContext({
				credentials: credentials!,
				parameters: {
					command: 'echo "$COMBINED_FOO"',
					useEphemeralSandbox: false,
					sandboxId,
					additionalFields: {},
				},
			});
			const verifyOut = (await codeRunCommand.execute.call(verifyCtx, 0))[0].json as Record<
				string,
				unknown
			>;
			expect(verifyOut.exitCode).toBe(0);
			expect(verifyOut.result).toContain('baz');
		});

		it('Sandbox.Create with Volume Mount — round-trip (create volume → mount → verify ls inside → cleanup)', async () => {
			const volumeName = `n8n-test-mount-${Date.now()}`;
			let volumeId = '';
			let sandboxId = '';

			try {
				const volCtx = createMockExecuteContext({
					credentials: credentials!,
					parameters: { name: volumeName },
				});
				const volume = (await volumeCreate.execute.call(volCtx, 0))[0].json as Record<
					string,
					unknown
				>;
				volumeId = volume.id as string;
				expect(volumeId).toBeTypeOf('string');

				const readyDeadline = Date.now() + 60_000;
				while (Date.now() < readyDeadline) {
					const getCtx = createMockExecuteContext({
						credentials: credentials!,
						parameters: { volumeId },
					});
					const v = (await volumeGet.execute.call(getCtx, 0))[0].json as Record<string, unknown>;
					if (v.state === 'ready') break;
					if (v.state === 'error') throw new Error(`Volume ${volumeId} entered error state`);
					await sleep(2000);
				}

				const mountPath = '/workspace/data';
				const sbCtx = createMockExecuteContext({
					credentials: credentials!,
					parameters: {
						snapshot: '',
						image: '',
						name: '',
						ephemeral: false,
						waitUntilStarted: true,
						waitTimeoutSeconds: 120,
						additionalFields: {
							volumes: { entry: [{ volumeId, mountPath }] },
						},
					},
				});
				const sb = (await sandboxCreate.execute.call(sbCtx, 0))[0].json as Record<
					string,
					unknown
				>;
				sandboxId = sb.id as string;
				expect(sb.state).toBe('started');

				const lsCtx = createMockExecuteContext({
					credentials: credentials!,
					parameters: {
						command: `ls -la ${mountPath} && echo "MOUNT_OK"`,
						useEphemeralSandbox: false,
						sandboxId,
						additionalFields: {},
					},
				});
				const lsOut = (await codeRunCommand.execute.call(lsCtx, 0))[0].json as Record<
					string,
					unknown
				>;
				expect(lsOut.exitCode).toBe(0);
				expect(lsOut.result).toContain('MOUNT_OK');
			} finally {
				if (sandboxId) {
					try {
						const delCtx = createMockExecuteContext({
							credentials: credentials!,
							parameters: { sandboxId },
						});
						await sandboxDelete.execute.call(delCtx, 0);
					} catch (err) {
						console.warn(`[volume-mount test] sandbox cleanup ${sandboxId}:`, err);
					}
				}
				if (volumeId) {
					try {
						const cleanupDeadline = Date.now() + 60_000;
						while (Date.now() < cleanupDeadline) {
							const getCtx = createMockExecuteContext({
								credentials: credentials!,
								parameters: { volumeId },
							});
							const v = (await volumeGet.execute.call(getCtx, 0))[0].json as Record<
								string,
								unknown
							>;
							if (v.state === 'ready' || v.state === 'error') break;
							await sleep(2000);
						}
						const delCtx = createMockExecuteContext({
							credentials: credentials!,
							parameters: { volumeId },
						});
						await volumeDelete.execute.call(delCtx, 0);
					} catch (err) {
						console.warn(`[volume-mount test] volume cleanup ${volumeId}:`, err);
					}
				}
			}
		});
	},
);
