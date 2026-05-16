import type { ServerContext, ToolResponse } from '../types/handler-types.js';
import { ContentDirectoryService } from '../../services/content-directory.js';
import { AVTransportService } from '../../services/av-transport.js';
import {
    classifyFavoriteUri,
    isContainerFavoriteUri,
    resolveFavoriteUri,
} from '../../services/favorites.js';
import type { DidlObject } from '../../didl/didl-object.js';

/**
 * Handle sonos_browse_artists
 */
export async function handleBrowseArtists(args: unknown, context: ServerContext): Promise<ToolResponse> {
    const { deviceId, startIndex = 0, count = 100 } = args as {
        deviceId: string;
        startIndex?: number;
        count?: number;
    };
    const device = await context.resolveDevice(deviceId);
    const service = new ContentDirectoryService(device);
    const result = await service.getArtists({ startIndex, count });

    const artists = result.items.map((item) => ({
        id: item.id,
        title: item.title,
        type: item.upnpClass,
    }));

    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    items: artists,
                    total: result.total,
                    returned: result.returned,
                }),
            },
        ],
    };
}

/**
 * Handle sonos_browse_albums
 */
export async function handleBrowseAlbums(args: unknown, context: ServerContext): Promise<ToolResponse> {
    const { deviceId, startIndex = 0, count = 100 } = args as {
        deviceId: string;
        startIndex?: number;
        count?: number;
    };
    const device = await context.resolveDevice(deviceId);
    const service = new ContentDirectoryService(device);
    const result = await service.getAlbums({ startIndex, count });

    const albums = result.items.map((item) => ({
        id: item.id,
        title: item.title,
        artist: item.getProperty('artist'),
        type: item.upnpClass,
    }));

    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    items: albums,
                    total: result.total,
                    returned: result.returned,
                }),
            },
        ],
    };
}

/**
 * Handle sonos_browse_tracks
 */
export async function handleBrowseTracks(args: unknown, context: ServerContext): Promise<ToolResponse> {
    const { deviceId, startIndex = 0, count = 100 } = args as {
        deviceId: string;
        startIndex?: number;
        count?: number;
    };
    const device = context.resolver.resolve(deviceId);
    const service = new ContentDirectoryService(device);
    const result = await service.getTracks({ startIndex, count });

    const tracks = result.items.map((item) => ({
        id: item.id,
        title: item.title,
        artist: item.getProperty('artist'),
        album: item.getProperty('album'),
        uri: item.resources[0]?.uri,
    }));

    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    items: tracks,
                    total: result.total,
                    returned: result.returned,
                }),
            },
        ],
    };
}

/**
 * Handle sonos_browse_genres
 */
export async function handleBrowseGenres(args: unknown, context: ServerContext): Promise<ToolResponse> {
    const { deviceId, startIndex = 0, count = 100 } = args as {
        deviceId: string;
        startIndex?: number;
        count?: number;
    };
    const device = context.resolver.resolve(deviceId);
    const service = new ContentDirectoryService(device);
    const result = await service.getGenres({ startIndex, count });

    const genres = result.items.map((item) => ({
        id: item.id,
        title: item.title,
        type: item.upnpClass,
    }));

    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    items: genres,
                    total: result.total,
                    returned: result.returned,
                }),
            },
        ],
    };
}

/**
 * Handle sonos_browse_playlists
 */
export async function handleBrowsePlaylists(args: unknown, context: ServerContext): Promise<ToolResponse> {
    const { deviceId, startIndex = 0, count = 100 } = args as {
        deviceId: string;
        startIndex?: number;
        count?: number;
    };
    const device = context.resolver.resolve(deviceId);
    const service = new ContentDirectoryService(device);
    const result = await service.getSonosPlaylists({ startIndex, count });

    const playlists = result.items.map((item) => ({
        id: item.id,
        title: item.title,
        type: item.upnpClass,
    }));

    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    items: playlists,
                    total: result.total,
                    returned: result.returned,
                }),
            },
        ],
    };
}

/**
 * Handle sonos_get_favorites
 *
 * Returns the contents of the Sonos Favorites container (FV:2) — the
 * unified list visible in the Sonos app, including radio stations,
 * playlists, albums, tracks, and library shortcuts. Each item is annotated
 * with `playableAs` (stream | container | track | unknown) derived from
 * the URI scheme so the agent can reason about it without re-classifying.
 */
export async function handleGetFavorites(args: unknown, context: ServerContext): Promise<ToolResponse> {
    const { deviceId, startIndex = 0, count = 100 } = args as {
        deviceId: string;
        startIndex?: number;
        count?: number;
    };
    const device = context.resolver.resolve(deviceId);
    const service = new ContentDirectoryService(device);
    const result = await service.getFavorites({ startIndex, count });

    const favorites = result.items.map((item) => {
        const uri = item.resources[0]?.uri;
        return {
            id: item.id,
            title: item.title,
            uri,
            playableAs: classifyFavoriteUri(uri),
            type: item.upnpClass,
        };
    });

    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    items: favorites,
                    total: result.total,
                    returned: result.returned,
                }),
            },
        ],
    };
}

/**
 * Handle sonos_play_favorite
 *
 * Plays a Sonos Favorite by `title` (case-insensitive exact match) or `id`
 * (FV:2/XX from `sonos_get_favorites`). One of them is required.
 *
 * Two transport flows depending on the favorite type:
 *   - Container favorites (Spotify/Apple albums, Sonos playlists, browsable
 *     items) are enqueued: clear queue → AddURIToQueue with the favorite's
 *     resMD → play from track 1. Direct SetAVTransportURI returns UPnP 714.
 *   - Stream/track favorites (radio, single tracks) are played directly via
 *     SetAVTransportURI. The queue is left alone, matching the Sonos app.
 */
export async function handlePlayFavorite(args: unknown, context: ServerContext): Promise<ToolResponse> {
    const { deviceId, title, id } = args as {
        deviceId: string;
        title?: string;
        id?: string;
    };

    if (!title && !id) {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({ error: 'either title or id is required' }),
            }],
            isError: true,
        };
    }

    const device = context.resolver.resolve(deviceId);
    const cd = new ContentDirectoryService(device);

    let favorite: DidlObject | undefined;

    if (id) {
        const result = await cd.browseMetadata(id);
        favorite = result.items[0];
    } else if (title) {
        // Paginate FV:2 until exact case-insensitive match. Favorites lists
        // are typically small (<100) so this is at most one round-trip.
        const wanted = title.trim().toLowerCase();
        const pageSize = 100;
        let startIndex = 0;
        // Hard cap defends against pathological listings; in practice FV:2
        // is small and we break out on the first empty page.
        const maxIterations = 50;
        for (let i = 0; i < maxIterations; i++) {
            const page = await cd.getFavorites({ startIndex, count: pageSize });
            favorite = page.items.find(item => item.title.toLowerCase() === wanted);
            if (favorite) break;
            startIndex += page.returned;
            if (page.returned === 0 || startIndex >= page.total) break;
        }
    }

    if (!favorite) {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({ error: 'favorite not found', title, id }),
            }],
            isError: true,
        };
    }

    const uri = await resolveFavoriteUri(favorite);
    if (!uri) {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    error: 'favorite has no playable URI',
                    favorite: { id: favorite.id, title: favorite.title },
                }),
            }],
            isError: true,
        };
    }

    // See note in resolveFavoriteUri — resourceMetaData is on subclasses;
    // read via the base accessor.
    const metadata = (favorite.getProperty('resourceMetaData') as string | undefined) ?? '';
    const av = new AVTransportService(device);

    if (isContainerFavoriteUri(uri)) {
        // Container favorite — must be enqueued, not set as transport URI.
        await av.removeAllTracksFromQueue();
        const firstTrack = await av.addToQueue({
            uri,
            metadata,
            position: 0,
            playNext: false,
        });
        // Some firmware variants omit FirstTrackNumberEnqueued; since we
        // just cleared the queue, position 1 is correct.
        await av.playFromQueue(firstTrack > 0 ? firstTrack : 1);
    } else {
        await av.setAVTransportURI(uri, metadata);
        await av.play();
    }

    return {
        content: [{
            type: 'text',
            text: JSON.stringify({
                status: 'playing',
                favorite: {
                    id: favorite.id,
                    title: favorite.title,
                    uri,
                    playableAs: classifyFavoriteUri(uri),
                },
            }),
        }],
    };
}

/**
 * Handle sonos_search_library
 */
export async function handleSearchLibrary(args: unknown, context: ServerContext): Promise<ToolResponse> {
    const { deviceId, searchType, searchTerm, startIndex = 0, count = 100 } = args as {
        deviceId: string;
        searchType: 'artists' | 'albums' | 'tracks' | 'genres';
        searchTerm: string;
        startIndex?: number;
        count?: number;
    };
    const device = context.resolver.resolve(deviceId);
    const service = new ContentDirectoryService(device);
    const result = await service.search(searchType, searchTerm, { startIndex, count });

    const items = result.items.map((item) => ({
        id: item.id,
        title: item.title,
        artist: item.getProperty('artist'),
        album: item.getProperty('album'),
        type: item.upnpClass,
    }));

    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    items,
                    total: result.total,
                    returned: result.returned,
                    searchTerm,
                    searchType,
                }),
            },
        ],
    };
}

/**
 * Handle sonos_browse_item
 */
export async function handleBrowseItem(args: unknown, context: ServerContext): Promise<ToolResponse> {
    const { deviceId, objectId, startIndex = 0, count = 100 } = args as {
        deviceId: string;
        objectId: string;
        startIndex?: number;
        count?: number;
    };
    const device = context.resolver.resolve(deviceId);
    const service = new ContentDirectoryService(device);
    const result = await service.browse(objectId, { startIndex, count });

    const items = result.items.map((item) => ({
        id: item.id,
        title: item.title,
        artist: item.getProperty('artist'),
        album: item.getProperty('album'),
        uri: item.resources[0]?.uri,
        type: item.upnpClass,
    }));

    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    items,
                    total: result.total,
                    returned: result.returned,
                    objectId,
                }),
            },
        ],
    };
}
