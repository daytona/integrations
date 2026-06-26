import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class DaytonaApi implements ICredentialType {
	name = 'daytonaApi';

	displayName = 'Daytona API';

	icon = { light: 'file:daytona.svg', dark: 'file:daytona.dark.svg' } as const;

	documentationUrl =
		'https://github.com/daytona/integrations/tree/main/packages/n8n-nodes-daytona#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Daytona API key. Create one at <a href="https://app.daytona.io/dashboard/keys" target="_blank">app.daytona.io/dashboard/keys</a>.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://app.daytona.io/api',
			placeholder: 'https://app.daytona.io/api',
			description:
				'Daytona API base URL. Override only when targeting a self-hosted Daytona instance. Leave the default for Daytona Cloud.',
		},
		{
			displayName: 'Organization ID',
			name: 'organizationId',
			type: 'string',
			default: '',
			description:
				'Required when using a JWT token. Optional with API keys (Daytona accepts the header on every request). Sent as the <code>X-Daytona-Organization-ID</code> header.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
				'X-Daytona-Organization-ID': '={{$credentials.organizationId || ""}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/api-keys/current',
		},
	};
}
