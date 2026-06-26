/* eslint-disable @n8n/community-nodes/no-restricted-globals */
export interface DaytonaTestCredentials {
	apiKey: string;
	baseUrl: string;
	organizationId: string;
}

export function getTestCredentials(): DaytonaTestCredentials | null {
	const apiKey = process.env.DAYTONA_API_KEY?.trim();
	if (!apiKey) return null;
	return {
		apiKey,
		baseUrl: process.env.DAYTONA_API_URL?.trim() || 'https://app.daytona.io/api',
		organizationId: process.env.DAYTONA_ORGANIZATION_ID?.trim() ?? '',
	};
}

export function shouldRunIntegration(): boolean {
	return getTestCredentials() !== null;
}

export function shouldRunEphemeral(): boolean {
	return shouldRunIntegration() && process.env.DAYTONA_TEST_INCLUDE_EPHEMERAL === '1';
}

export function shouldRunCreateMatrix(): boolean {
	return shouldRunIntegration() && process.env.DAYTONA_TEST_INCLUDE_CREATE_MATRIX === '1';
}

export const TEST_MATRIX_DEFAULTS = {
	image: process.env.DAYTONA_TEST_IMAGE?.trim() || 'python:3.11',
};

export const TEST_DEFAULTS = {
	snapshot: process.env.DAYTONA_TEST_SNAPSHOT?.trim() || undefined,
	gitRepoUrl: process.env.DAYTONA_TEST_GIT_REPO || 'https://github.com/octocat/Hello-World.git',
};
