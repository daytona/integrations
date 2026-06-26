/* eslint-disable @n8n/community-nodes/no-restricted-imports */
import { describe, expect, it } from 'vitest';

import * as codeRunCode from '../nodes/Daytona/actions/code/runCode.operation';
import * as codeRunCommand from '../nodes/Daytona/actions/code/runCommand.operation';

import { createMockExecuteContext } from './helpers/mock-execute';
import { getTestCredentials, shouldRunEphemeral } from './helpers/test-config';

const credentials = getTestCredentials();

describe.skipIf(!shouldRunEphemeral())('Daytona n8n node — ephemeral mode', () => {
	it('Code.RunCommand — ephemeral sandbox is created, used, and deleted', async () => {
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				command: 'whoami',
				useEphemeralSandbox: true,
				snapshot: '',
				additionalFields: { waitTimeoutSeconds: 90 },
			},
		});

		const result = await codeRunCommand.execute.call(ctx, 0);
		const out = result[0].json as Record<string, unknown>;

		expect(out.exitCode).toBe(0);
		expect(out.ephemeral).toBe(true);
		expect(out.sandboxId).toBeTypeOf('string');
		expect(out.cleanupWarning).toBeUndefined();
		expect(out.result).toBeTypeOf('string');
		expect((out.result as string).trim().length).toBeGreaterThan(0);
	});

	it('Code.RunCode — ephemeral python execution', async () => {
		const ctx = createMockExecuteContext({
			credentials: credentials!,
			parameters: {
				code: 'import sys; print(sys.version_info[:2])',
				language: 'python',
				useEphemeralSandbox: true,
				snapshot: '',
				additionalFields: { waitTimeoutSeconds: 90 },
			},
		});

		const result = await codeRunCode.execute.call(ctx, 0);
		const out = result[0].json as Record<string, unknown>;

		expect(out.exitCode).toBe(0);
		expect(out.ephemeral).toBe(true);
		expect(out.sandboxId).toBeTypeOf('string');
		expect(out.result).toMatch(/\d+,\s*\d+/);
	});
});
