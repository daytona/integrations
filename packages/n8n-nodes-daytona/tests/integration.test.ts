/* eslint-disable @n8n/community-nodes/no-restricted-imports, no-console */
import { sleep } from 'n8n-workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as sandboxCreate from '../nodes/Daytona/actions/sandbox/create.operation';
import * as sandboxDelete from '../nodes/Daytona/actions/sandbox/delete.operation';
import * as sandboxGet from '../nodes/Daytona/actions/sandbox/get.operation';
import * as sandboxGetMany from '../nodes/Daytona/actions/sandbox/getMany.operation';
import * as sandboxGetPreviewUrl from '../nodes/Daytona/actions/sandbox/getPreviewUrl.operation';
import * as sandboxStart from '../nodes/Daytona/actions/sandbox/start.operation';
import * as sandboxStop from '../nodes/Daytona/actions/sandbox/stop.operation';
import * as codeRunCode from '../nodes/Daytona/actions/code/runCode.operation';
import * as codeRunCommand from '../nodes/Daytona/actions/code/runCommand.operation';
import * as fileCreateFolder from '../nodes/Daytona/actions/file/createFolder.operation';
import * as fileDelete from '../nodes/Daytona/actions/file/delete.operation';
import * as fileDownload from '../nodes/Daytona/actions/file/download.operation';
import * as fileList from '../nodes/Daytona/actions/file/list.operation';
import * as fileMove from '../nodes/Daytona/actions/file/move.operation';
import * as fileUpload from '../nodes/Daytona/actions/file/upload.operation';
import * as gitAdd from '../nodes/Daytona/actions/git/add.operation';
import * as gitCheckout from '../nodes/Daytona/actions/git/checkout.operation';
import * as gitClone from '../nodes/Daytona/actions/git/clone.operation';
import * as gitCommit from '../nodes/Daytona/actions/git/commit.operation';
import * as gitStatus from '../nodes/Daytona/actions/git/status.operation';

import { createMockExecuteContext, makeBinaryInput } from './helpers/mock-execute';
import { getTestCredentials, shouldRunIntegration, TEST_DEFAULTS } from './helpers/test-config';

const credentials = getTestCredentials();

describe.skipIf(!shouldRunIntegration())('Daytona n8n node — integration', () => {
	const sharedState: { sandboxId?: string } = {};

	beforeAll(async () => {
		expect(credentials).not.toBeNull();
	});

	afterAll(async () => {
		if (!sharedState.sandboxId || !credentials) return;
		try {
			const ctx = createMockExecuteContext({
				credentials,
				parameters: { sandboxId: sharedState.sandboxId },
			});
			await sandboxDelete.execute.call(ctx, 0);
		} catch (err) {
			console.warn(`[afterAll] failed to delete sandbox ${sharedState.sandboxId}:`, err);
		}
	});

	it('Sandbox.Create — minimal create + wait until started', async () => {
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				snapshot: '',
				name: `n8n-test-${Date.now()}`,
				ephemeral: false,
				waitUntilStarted: true,
				waitTimeoutSeconds: 90,
				additionalFields: {},
			},
		});

		const result = await sandboxCreate.execute.call(ctx, 0);
		expect(result).toHaveLength(1);
		const sandbox = result[0].json as Record<string, unknown>;

		expect(sandbox.id).toBeTypeOf('string');
		expect(sandbox.state).toBe('started');
		expect(sandbox.toolboxProxyUrl).toBeTypeOf('string');

		sharedState.sandboxId = sandbox.id as string;
	});

	it('Sandbox.Get — retrieve the sandbox we just created', async () => {
		expect(sharedState.sandboxId).toBeDefined();
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { sandboxId: sharedState.sandboxId },
		});
		const result = await sandboxGet.execute.call(ctx, 0);
		const sandbox = result[0].json as Record<string, unknown>;
		expect(sandbox.id).toBe(sharedState.sandboxId);
		expect(sandbox.state).toBe('started');
	});

	it('Sandbox.GetMany — list includes our sandbox', async () => {
		expect(sharedState.sandboxId).toBeDefined();
		await sleep(2000);
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { returnAll: false, limit: 100 },
		});
		const result = await sandboxGetMany.execute.call(ctx, 0);
		const ids = result.map((r) => (r.json as { id?: string }).id);
		expect(ids).toContain(sharedState.sandboxId);
	});

	it('Code.RunCommand — echo on existing sandbox', async () => {
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				command: 'echo "hello from n8n"',
				useEphemeralSandbox: false,
				sandboxId: sharedState.sandboxId,
				additionalFields: {},
			},
		});
		const result = await codeRunCommand.execute.call(ctx, 0);
		const out = result[0].json as Record<string, unknown>;
		expect(out.exitCode).toBe(0);
		expect(out.result).toContain('hello from n8n');
	});

	it('Code.RunCode — python print on existing sandbox', async () => {
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				code: 'print("from python")',
				language: 'python',
				useEphemeralSandbox: false,
				sandboxId: sharedState.sandboxId,
				additionalFields: {},
			},
		});
		const result = await codeRunCode.execute.call(ctx, 0);
		const out = result[0].json as Record<string, unknown>;
		expect(out.exitCode).toBe(0);
		expect(out.result).toContain('from python');
	});

	it('Code.RunCommand — non-zero exit code surfaces as data, not throw', async () => {
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				command: 'ls /this/path/does/not/exist',
				useEphemeralSandbox: false,
				sandboxId: sharedState.sandboxId,
				additionalFields: {},
			},
		});
		const result = await codeRunCommand.execute.call(ctx, 0);
		const out = result[0].json as Record<string, unknown>;
		expect(out.exitCode).not.toBe(0);
		expect(out.result).toBeTruthy();
	});

	it('File.Upload — multipart upload then read back via cat', async () => {
		const payload = `n8n-test-payload-${Date.now()}`;
		const remotePath = '/tmp/n8n-test.txt';

		const uploadCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				sandboxId: sharedState.sandboxId,
				remotePath,
				binaryPropertyName: 'data',
			},
			inputBinary: makeBinaryInput(Buffer.from(payload), 'n8n-test.txt', 'text/plain'),
		});
		const uploadResult = await fileUpload.execute.call(uploadCtx, 0);
		const uploadOut = uploadResult[0].json as Record<string, unknown>;
		expect(uploadOut.success).toBe(true);
		expect(uploadOut.sizeBytes).toBe(payload.length);

		const catCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				command: `cat ${remotePath}`,
				useEphemeralSandbox: false,
				sandboxId: sharedState.sandboxId,
				additionalFields: {},
			},
		});
		const catResult = await codeRunCommand.execute.call(catCtx, 0);
		const catOut = catResult[0].json as Record<string, unknown>;
		expect(catOut.exitCode).toBe(0);
		expect(catOut.result).toContain(payload);
	});

	it('File.Download — write via shell, download, verify buffer', async () => {
		const payload = `download-test-${Date.now()}`;
		const remotePath = '/tmp/n8n-download.txt';

		const writeCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				command: `printf '%s' '${payload}' > ${remotePath}`,
				useEphemeralSandbox: false,
				sandboxId: sharedState.sandboxId,
				additionalFields: {},
			},
		});
		const writeResult = await codeRunCommand.execute.call(writeCtx, 0);
		expect((writeResult[0].json as Record<string, unknown>).exitCode).toBe(0);

		const downloadCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				sandboxId: sharedState.sandboxId,
				remotePath,
				binaryPropertyName: 'data',
			},
		});
		const downloadResult = await fileDownload.execute.call(downloadCtx, 0);
		const item = downloadResult[0];
		const json = item.json as Record<string, unknown>;
		const binary = item.binary?.data;

		expect(json.success).toBe(true);
		expect(binary).toBeDefined();
		expect(binary?.data).toBeTypeOf('string');

		const decoded = Buffer.from(binary!.data!, 'base64').toString('utf-8');
		expect(decoded).toBe(payload);
	});

	it('File.CreateFolder — create folder then verify it appears in List', async () => {
		const folderPath = '/tmp/integration-test-folder';
		const createCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				sandboxId: sharedState.sandboxId,
				path: folderPath,
				mode: '0755',
			},
		});
		const createOut = (await fileCreateFolder.execute.call(createCtx, 0))[0].json as Record<
			string,
			unknown
		>;
		expect(createOut.success).toBe(true);

		const listCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { sandboxId: sharedState.sandboxId, path: '/tmp' },
		});
		const listOut = (await fileList.execute.call(listCtx, 0))[0].json as Record<string, unknown>;
		const files = listOut.files as Array<{ name: string; isDir: boolean }>;
		const created = files.find((f) => f.name === 'integration-test-folder');
		expect(created).toBeDefined();
		expect(created?.isDir).toBe(true);
	});

	it('File.Move — rename a file then verify both old/new paths', async () => {
		const oldName = '/tmp/integration-test-folder/original.txt';
		const newName = '/tmp/integration-test-folder/renamed.txt';

		const writeCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				command: `echo 'move test' > ${oldName}`,
				useEphemeralSandbox: false,
				sandboxId: sharedState.sandboxId,
				additionalFields: {},
			},
		});
		await codeRunCommand.execute.call(writeCtx, 0);

		const moveCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { sandboxId: sharedState.sandboxId, source: oldName, destination: newName },
		});
		const moveOut = (await fileMove.execute.call(moveCtx, 0))[0].json as Record<string, unknown>;
		expect(moveOut.success).toBe(true);

		const listCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { sandboxId: sharedState.sandboxId, path: '/tmp/integration-test-folder' },
		});
		const listOut = (await fileList.execute.call(listCtx, 0))[0].json as Record<string, unknown>;
		const names = (listOut.files as Array<{ name: string }>).map((f) => f.name);
		expect(names).toContain('renamed.txt');
		expect(names).not.toContain('original.txt');
	});

	it('File.Delete — recursive delete of the test folder', async () => {
		const deleteCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				sandboxId: sharedState.sandboxId,
				path: '/tmp/integration-test-folder',
				recursive: true,
			},
		});
		const deleteOut = (await fileDelete.execute.call(deleteCtx, 0))[0].json as Record<
			string,
			unknown
		>;
		expect(deleteOut.success).toBe(true);

		const listCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { sandboxId: sharedState.sandboxId, path: '/tmp' },
		});
		const listOut = (await fileList.execute.call(listCtx, 0))[0].json as Record<string, unknown>;
		const names = (listOut.files as Array<{ name: string }>).map((f) => f.name);
		expect(names).not.toContain('integration-test-folder');
	});

	it('Git.Clone — clone Hello-World repo', async () => {
		const cloneCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				sandboxId: sharedState.sandboxId,
				repositoryUrl: TEST_DEFAULTS.gitRepoUrl,
				path: '/tmp/hello-world',
				additionalFields: {},
			},
		});
		const cloneResult = await gitClone.execute.call(cloneCtx, 0);
		const out = cloneResult[0].json as Record<string, unknown>;
		expect(out.success).toBe(true);

		const verifyCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				command: 'ls /tmp/hello-world',
				useEphemeralSandbox: false,
				sandboxId: sharedState.sandboxId,
				additionalFields: {},
			},
		});
		const verifyResult = await codeRunCommand.execute.call(verifyCtx, 0);
		const verifyOut = verifyResult[0].json as Record<string, unknown>;
		expect(verifyOut.exitCode).toBe(0);
		expect(verifyOut.result).toBeTypeOf('string');
		expect((verifyOut.result as string).length).toBeGreaterThan(0);
	});

	it('Git.Status — clean working tree after fresh clone', async () => {
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { sandboxId: sharedState.sandboxId, path: '/tmp/hello-world' },
		});
		const out = (await gitStatus.execute.call(ctx, 0))[0].json as Record<string, unknown>;
		expect(out.currentBranch).toBeTypeOf('string');
		expect((out.currentBranch as string).length).toBeGreaterThan(0);
		expect(Array.isArray(out.fileStatus)).toBe(true);
	});

	it('Git.Add + Git.Commit + Git.Status — stage, commit, verify clean tree afterward', async () => {
		const editCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				command: "echo 'integration-test marker' >> /tmp/hello-world/README",
				useEphemeralSandbox: false,
				sandboxId: sharedState.sandboxId,
				additionalFields: {},
			},
		});
		const editResult = await codeRunCommand.execute.call(editCtx, 0);
		expect((editResult[0].json as Record<string, unknown>).exitCode).toBe(0);

		const addCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { sandboxId: sharedState.sandboxId, path: '/tmp/hello-world', files: '.' },
		});
		const addOut = (await gitAdd.execute.call(addCtx, 0))[0].json as Record<string, unknown>;
		expect(addOut.success).toBe(true);

		const commitCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				sandboxId: sharedState.sandboxId,
				path: '/tmp/hello-world',
				message: 'test: integration test commit',
				author: 'Daytona n8n Test',
				email: 'test@daytona.io',
				additionalFields: {},
			},
		});
		const commitOut = (await gitCommit.execute.call(commitCtx, 0))[0].json as Record<
			string,
			unknown
		>;
		expect(commitOut.success).toBe(true);
		expect(commitOut.hash).toBeTypeOf('string');
		expect((commitOut.hash as string).length).toBeGreaterThanOrEqual(7);

		const statusAfterCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { sandboxId: sharedState.sandboxId, path: '/tmp/hello-world' },
		});
		const statusOut = (await gitStatus.execute.call(statusAfterCtx, 0))[0].json as Record<
			string,
			unknown
		>;
		expect(statusOut.fileStatus).toEqual([]);
		expect(statusOut.ahead).toBeTypeOf('number');
	});

	it('Git.Checkout — create branch via shell then switch back', async () => {
		const createBranchCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				command:
					'cd /tmp/hello-world && git checkout -b integration-test-branch && git rev-parse --abbrev-ref HEAD',
				useEphemeralSandbox: false,
				sandboxId: sharedState.sandboxId,
				additionalFields: {},
			},
		});
		const createOut = (await codeRunCommand.execute.call(createBranchCtx, 0))[0].json as Record<
			string,
			unknown
		>;
		expect(createOut.exitCode).toBe(0);
		expect((createOut.result as string).trim().endsWith('integration-test-branch')).toBe(true);

		const checkoutCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				sandboxId: sharedState.sandboxId,
				path: '/tmp/hello-world',
				branch: 'master',
			},
		});
		const checkoutOut = (await gitCheckout.execute.call(checkoutCtx, 0))[0].json as Record<
			string,
			unknown
		>;
		expect(checkoutOut.success).toBe(true);

		const statusCtx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { sandboxId: sharedState.sandboxId, path: '/tmp/hello-world' },
		});
		const statusOut = (await gitStatus.execute.call(statusCtx, 0))[0].json as Record<
			string,
			unknown
		>;
		expect(statusOut.currentBranch).toBe('master');
	});

	it('Sandbox.GetPreviewUrl — signed URL for port 3000', async () => {
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				sandboxId: sharedState.sandboxId,
				port: 3000,
				urlType: 'signed',
				expiresInSeconds: 3600,
			},
		});
		const result = await sandboxGetPreviewUrl.execute.call(ctx, 0);
		const out = result[0].json as Record<string, unknown>;
		expect(out.url).toBeTypeOf('string');
		expect(out.url as string).toMatch(/^https?:\/\//);
		expect(out.urlType).toBe('signed');
	});

	it('Sandbox.Stop — stop and wait for stopped state', async () => {
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				sandboxId: sharedState.sandboxId,
				waitUntilStopped: true,
				waitTimeoutSeconds: 60,
			},
		});
		const result = await sandboxStop.execute.call(ctx, 0);
		const sandbox = result[0].json as Record<string, unknown>;
		expect(sandbox.state).toMatch(/stopped|archived/);
	});

	it('Sandbox.Start — start and wait for started state', async () => {
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				sandboxId: sharedState.sandboxId,
				waitUntilStarted: true,
				waitTimeoutSeconds: 90,
			},
		});
		const result = await sandboxStart.execute.call(ctx, 0);
		const sandbox = result[0].json as Record<string, unknown>;
		expect(sandbox.state).toBe('started');
	});

	it('Sandbox.Delete — explicit delete (afterAll fallback would also handle this)', async () => {
		expect(sharedState.sandboxId).toBeDefined();
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: { sandboxId: sharedState.sandboxId },
		});
		const result = await sandboxDelete.execute.call(ctx, 0);
		const out = result[0].json as Record<string, unknown>;
		expect(out.success).toBe(true);
		expect(out.sandboxId).toBe(sharedState.sandboxId);
		sharedState.sandboxId = undefined;
	});
});
