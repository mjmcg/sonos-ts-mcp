import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const libraryTools: Tool[] = [
    {
        name: 'sonos_browse_artists',
        description: 'Browse artists in the music library. Supports pagination for large collections.',
        inputSchema: {
            type: 'object',
            properties: {
                deviceId: {
                    type: 'string',
                    description: 'Room name, UUID, or IP address',
                },
                startIndex: {
                    type: 'number',
                    description: 'Starting index for pagination (default: 0)',
                    default: 0,
                },
                count: {
                    type: 'number',
                    description: 'Number of items to return (default: 100)',
                    default: 100,
                },
            },
            required: ['deviceId'],
        },
    },
    {
        name: 'sonos_browse_albums',
        description: 'Browse albums in the music library. Supports pagination for large collections.',
        inputSchema: {
            type: 'object',
            properties: {
                deviceId: {
                    type: 'string',
                    description: 'Room name, UUID, or IP address',
                },
                startIndex: {
                    type: 'number',
                    description: 'Starting index for pagination (default: 0)',
                    default: 0,
                },
                count: {
                    type: 'number',
                    description: 'Number of items to return (default: 100)',
                    default: 100,
                },
            },
            required: ['deviceId'],
        },
    },
    {
        name: 'sonos_browse_tracks',
        description: 'Browse all tracks in the music library. Supports pagination for large collections.',
        inputSchema: {
            type: 'object',
            properties: {
                deviceId: {
                    type: 'string',
                    description: 'Room name, UUID, or IP address',
                },
                startIndex: {
                    type: 'number',
                    description: 'Starting index for pagination (default: 0)',
                    default: 0,
                },
                count: {
                    type: 'number',
                    description: 'Number of items to return (default: 100)',
                    default: 100,
                },
            },
            required: ['deviceId'],
        },
    },
    {
        name: 'sonos_browse_genres',
        description: 'Browse music genres in the library. Supports pagination for large collections.',
        inputSchema: {
            type: 'object',
            properties: {
                deviceId: {
                    type: 'string',
                    description: 'Room name, UUID, or IP address',
                },
                startIndex: {
                    type: 'number',
                    description: 'Starting index for pagination (default: 0)',
                    default: 0,
                },
                count: {
                    type: 'number',
                    description: 'Number of items to return (default: 100)',
                    default: 100,
                },
            },
            required: ['deviceId'],
        },
    },
    {
        name: 'sonos_browse_playlists',
        description: 'Browse Sonos playlists. Supports pagination for large collections.',
        inputSchema: {
            type: 'object',
            properties: {
                deviceId: {
                    type: 'string',
                    description: 'Room name, UUID, or IP address',
                },
                startIndex: {
                    type: 'number',
                    description: 'Starting index for pagination (default: 0)',
                    default: 0,
                },
                count: {
                    type: 'number',
                    description: 'Number of items to return (default: 100)',
                    default: 100,
                },
            },
            required: ['deviceId'],
        },
    },
    {
        name: 'sonos_get_favorites',
        description: 'Get the Sonos Favorites (FV:2) — the unified favorites list visible in the Sonos app, including radio stations, playlists, albums, tracks, and library shortcuts. Each item is annotated with `playableAs` (stream | container | track | unknown) derived from the URI scheme. To play a favorite, prefer sonos_play_favorite over extracting the URI yourself — it handles the container-vs-stream distinction correctly.',
        inputSchema: {
            type: 'object',
            properties: {
                deviceId: {
                    type: 'string',
                    description: 'Room name, UUID, or IP address',
                },
                startIndex: {
                    type: 'number',
                    description: 'Starting index for pagination (default: 0)',
                    default: 0,
                },
                count: {
                    type: 'number',
                    description: 'Number of items to return (default: 100)',
                    default: 100,
                },
            },
            required: ['deviceId'],
        },
    },
    {
        name: 'sonos_play_favorite',
        description: 'Play a Sonos Favorite (from FV:2) by title or id. Exactly one of `title` (case-insensitive exact match) or `id` (e.g. FV:2/65 from sonos_get_favorites) is required. Handles both stream favorites (radio, single tracks — played directly) and container favorites (albums, playlists — enqueued and played from track 1, since Sonos rejects SetAVTransportURI for container schemes with UPnP 714).',
        inputSchema: {
            type: 'object',
            properties: {
                deviceId: {
                    type: 'string',
                    description: 'Room name, UUID, or IP address',
                },
                title: {
                    type: 'string',
                    description: 'Exact favorite title (case-insensitive). Either title or id is required.',
                },
                id: {
                    type: 'string',
                    description: 'Favorite ID (e.g. "FV:2/65") from a sonos_get_favorites result. Either title or id is required.',
                },
            },
            required: ['deviceId'],
        },
    },
    {
        name: 'sonos_search_library',
        description: 'Search the music library by artist, album, track, or genre. Returns matching items.',
        inputSchema: {
            type: 'object',
            properties: {
                deviceId: {
                    type: 'string',
                    description: 'Room name, UUID, or IP address',
                },
                searchType: {
                    type: 'string',
                    description: 'Type of content to search',
                    enum: ['artists', 'albums', 'tracks', 'genres'],
                },
                searchTerm: {
                    type: 'string',
                    description: 'Search term',
                },
                startIndex: {
                    type: 'number',
                    description: 'Starting index for pagination (default: 0)',
                    default: 0,
                },
                count: {
                    type: 'number',
                    description: 'Number of items to return (default: 100)',
                    default: 100,
                },
            },
            required: ['deviceId', 'searchType', 'searchTerm'],
        },
    },
    {
        name: 'sonos_browse_item',
        description: 'Browse a specific library item to get its children. For example, get albums for an artist or tracks for an album.',
        inputSchema: {
            type: 'object',
            properties: {
                deviceId: {
                    type: 'string',
                    description: 'Room name, UUID, or IP address',
                },
                objectId: {
                    type: 'string',
                    description: 'Object ID from a previous browse or search result',
                },
                startIndex: {
                    type: 'number',
                    description: 'Starting index for pagination (default: 0)',
                    default: 0,
                },
                count: {
                    type: 'number',
                    description: 'Number of items to return (default: 100)',
                    default: 100,
                },
            },
            required: ['deviceId', 'objectId'],
        },
    },
];
