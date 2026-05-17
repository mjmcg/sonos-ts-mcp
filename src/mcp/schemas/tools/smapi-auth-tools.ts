import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * SMAPI authentication tools.
 *
 * Two-step flow: begin → user completes on partner site → complete.
 * These tools are for human-driven setup, not agent automation. Status
 * and remove are convenience tools for diagnosing and clearing tokens.
 *
 * Tokens persist on disk under MCP_DATA_DIR/smapi-tokens.json so the
 * linking survives container rebuilds.
 */
export const smapiAuthTools: Tool[] = [
    {
        name: 'sonos_smapi_auth_begin',
        description:
            'Begin the SMAPI authentication flow for a music service (Apple Music, ' +
            'Spotify, AccuRadio, SiriusXM, etc.). Returns a registration URL and a ' +
            'short link code; open the URL in a browser and enter the code on the ' +
            'partner site to authorize. Then call sonos_smapi_auth_complete with the ' +
            'same link code to exchange it for a stored token. Anonymous services ' +
            '(TuneIn, SomaFM, CBC Radio &amp; Music, etc.) do not need this — they ' +
            'work out of the box. NOTE: this is a separate authentication from the ' +
            'one performed in the Sonos app; third-party clients cannot read the ' +
            'Sonos app tokens, so each client (the MCP server included) must link ' +
            'independently.',
        inputSchema: {
            type: 'object',
            properties: {
                deviceId: {
                    type: 'string',
                    description: 'Room name, UUID, or IP address of any player in the household',
                },
                serviceName: {
                    type: 'string',
                    description: 'Exact service name from sonos_list_music_services (e.g. "Apple Music")',
                },
            },
            required: ['deviceId', 'serviceName'],
        },
    },
    {
        name: 'sonos_smapi_auth_complete',
        description:
            'Complete the SMAPI authentication flow by exchanging the link code for ' +
            'a long-lived token pair. Call this after the user has approved the link ' +
            'on the partner site. The same linkCode returned by sonos_smapi_auth_begin ' +
            'is used here. On success, the token is persisted to disk and subsequent ' +
            'browse/search/play calls for this service will work.',
        inputSchema: {
            type: 'object',
            properties: {
                deviceId: {
                    type: 'string',
                    description: 'Same deviceId used in sonos_smapi_auth_begin',
                },
                serviceName: {
                    type: 'string',
                    description: 'Same serviceName used in sonos_smapi_auth_begin',
                },
                linkCode: {
                    type: 'string',
                    description: 'The link code from sonos_smapi_auth_begin (or from the partner-site redirect for AppLink flows)',
                },
                linkDeviceId: {
                    type: 'string',
                    description: 'Optional. The linkDeviceId from sonos_smapi_auth_begin; defaults to the player deviceId if omitted',
                },
            },
            required: ['deviceId', 'serviceName', 'linkCode'],
        },
    },
    {
        name: 'sonos_smapi_auth_status',
        description:
            'List which music services are linked (have a stored SMAPI token) for ' +
            'this household. Useful for diagnosing why a service browse returns empty: ' +
            'if requiresLink=true but linked=false, run sonos_smapi_auth_begin.',
        inputSchema: {
            type: 'object',
            properties: {
                deviceId: {
                    type: 'string',
                    description: 'Room name, UUID, or IP address of any player in the household',
                },
            },
            required: ['deviceId'],
        },
    },
    {
        name: 'sonos_smapi_auth_remove',
        description:
            'Remove the stored SMAPI token for a service from disk. Use to force a ' +
            're-link, or when removing a service from the household. Does not affect ' +
            'the Sonos-app-side linking — that is managed separately in the Sonos app.',
        inputSchema: {
            type: 'object',
            properties: {
                deviceId: {
                    type: 'string',
                    description: 'Room name, UUID, or IP address of any player in the household',
                },
                serviceName: {
                    type: 'string',
                    description: 'Exact service name from sonos_list_music_services',
                },
            },
            required: ['deviceId', 'serviceName'],
        },
    },
];
