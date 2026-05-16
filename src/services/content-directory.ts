import { BaseService } from './base-service.js';
import { RequestBuilder } from '../soap/request-builder.js';
import { XmlParser } from '../soap/response-parser.js';
import { fromDidlString } from '../didl/didl-parser.js';
import type { DidlObject } from '../didl/didl-object.js';

/**
 * Search result with pagination information
 */
export interface SearchResult {
    items: DidlObject[];
    total: number;
    returned: number;
    updateId?: number;
}

/**
 * Browse options
 */
export interface BrowseOptions {
    startIndex?: number;
    count?: number;
    filter?: string;
    sortCriteria?: string;
}

/**
 * Search types for music library browsing
 */
export type SearchType =
    | 'artists'
    | 'album_artists'
    | 'albums'
    | 'genres'
    | 'composers'
    | 'tracks'
    | 'playlists'
    | 'sonos_playlists'
    | 'sonos_favorites'
    | 'radio_stations'
    | 'radio_shows'
    | 'share';

/**
 * ContentDirectory service for browsing music library and managing content
 * Based on SoCo's MusicLibrary implementation
 */
export class ContentDirectoryService extends BaseService {
    protected getServiceType(): string {
        return 'urn:schemas-upnp-org:service:ContentDirectory:1';
    }

    protected getControlEndpoint(): string {
        return '/MediaServer/ContentDirectory/Control';
    }

    /**
     * Browse a container or item
     * @param objectId - The object ID to browse (e.g., 'Q:0' for queue)
     * @param options - Browse options
     * @returns Search result with items and pagination info
     */
    async browse(objectId: string, options: BrowseOptions = {}): Promise<SearchResult> {
        const {
            startIndex = 0,
            count = 100,
            filter = '*',
            sortCriteria = '',
        } = options;

        const body = RequestBuilder.buildSimpleBody({
            ObjectID: objectId,
            BrowseFlag: 'BrowseDirectChildren',
            Filter: filter,
            StartingIndex: startIndex,
            RequestedCount: count,
            SortCriteria: sortCriteria,
        });

        const response = await this.callAction('Browse', body);

        if (!response.success || !response.body) {
            return { items: [], total: 0, returned: 0 };
        }

        const result = XmlParser.extractValue(response.body, 'Result') ?? '';
        const totalMatches = parseInt(XmlParser.extractValue(response.body, 'TotalMatches') ?? '0');
        const numberReturned = parseInt(XmlParser.extractValue(response.body, 'NumberReturned') ?? '0');
        const updateId = parseInt(XmlParser.extractValue(response.body, 'UpdateID') ?? '0');

        let items: DidlObject[] = [];
        if (result) {
            try {
                const unescapedResult = XmlParser.unescapeXml(result);
                items = await fromDidlString(unescapedResult);
            } catch (error) {
                console.error('Error parsing DIDL result:', error);
            }
        }

        return {
            items,
            total: totalMatches,
            returned: numberReturned,
            updateId,
        };
    }

    /**
     * Browse metadata for a specific object
     * @param objectId - The object ID
     * @returns Search result with single item
     */
    async browseMetadata(objectId: string): Promise<SearchResult> {
        const body = RequestBuilder.buildSimpleBody({
            ObjectID: objectId,
            BrowseFlag: 'BrowseMetadata',
            Filter: '*',
            StartingIndex: 0,
            RequestedCount: 1,
            SortCriteria: '',
        });

        const response = await this.callAction('Browse', body);

        if (!response.success || !response.body) {
            return { items: [], total: 0, returned: 0 };
        }

        const result = XmlParser.extractValue(response.body, 'Result') ?? '';

        let items: DidlObject[] = [];
        if (result) {
            try {
                const unescapedResult = XmlParser.unescapeXml(result);
                items = await fromDidlString(unescapedResult);
            } catch (error) {
                console.error('Error parsing DIDL result:', error);
            }
        }

        return {
            items,
            total: items.length,
            returned: items.length,
        };
    }

    /**
     * Get the music library search object ID for a given search type
     */
    private getSearchTypeObjectId(searchType: SearchType): string {
        const searchTypeMap: Record<SearchType, string> = {
            'artists': 'A:ARTIST',
            'album_artists': 'A:ALBUMARTIST',
            'albums': 'A:ALBUM',
            'genres': 'A:GENRE',
            'composers': 'A:COMPOSER',
            'tracks': 'A:TRACKS',
            'playlists': 'A:PLAYLISTS',
            'sonos_playlists': 'SQ:',
            'sonos_favorites': 'FV:2',
            'radio_stations': 'R:0/0',
            'radio_shows': 'R:0/1',
            'share': 'S:',
        };

        return searchTypeMap[searchType] || 'A:';
    }

    /**
     * Get artists from the music library
     * @param options - Browse options
     * @returns Search result with artists
     */
    async getArtists(options: BrowseOptions = {}): Promise<SearchResult> {
        return this.browse(this.getSearchTypeObjectId('artists'), options);
    }

    /**
     * Get album artists from the music library
     * @param options - Browse options
     * @returns Search result with album artists
     */
    async getAlbumArtists(options: BrowseOptions = {}): Promise<SearchResult> {
        return this.browse(this.getSearchTypeObjectId('album_artists'), options);
    }

    /**
     * Get albums from the music library
     * @param options - Browse options
     * @returns Search result with albums
     */
    async getAlbums(options: BrowseOptions = {}): Promise<SearchResult> {
        return this.browse(this.getSearchTypeObjectId('albums'), options);
    }

    /**
     * Get genres from the music library
     * @param options - Browse options
     * @returns Search result with genres
     */
    async getGenres(options: BrowseOptions = {}): Promise<SearchResult> {
        return this.browse(this.getSearchTypeObjectId('genres'), options);
    }

    /**
     * Get composers from the music library
     * @param options - Browse options
     * @returns Search result with composers
     */
    async getComposers(options: BrowseOptions = {}): Promise<SearchResult> {
        return this.browse(this.getSearchTypeObjectId('composers'), options);
    }

    /**
     * Get tracks from the music library
     * @param options - Browse options
     * @returns Search result with tracks
     */
    async getTracks(options: BrowseOptions = {}): Promise<SearchResult> {
        return this.browse(this.getSearchTypeObjectId('tracks'), options);
    }

    /**
     * Get imported playlists from the music library
     * @param options - Browse options
     * @returns Search result with playlists
     */
    async getPlaylists(options: BrowseOptions = {}): Promise<SearchResult> {
        return this.browse(this.getSearchTypeObjectId('playlists'), options);
    }

    /**
     * Get Sonos playlists
     * @param options - Browse options
     * @returns Search result with Sonos playlists
     */
    async getSonosPlaylists(options: BrowseOptions = {}): Promise<SearchResult> {
        return this.browse(this.getSearchTypeObjectId('sonos_playlists'), options);
    }

    /**
     * Get Sonos favorites
     * @param options - Browse options
     * @returns Search result with favorites
     */
    async getSonosFavorites(options: BrowseOptions = {}): Promise<SearchResult> {
        return this.browse(this.getSearchTypeObjectId('sonos_favorites'), options);
    }

    /**
     * URI schemes that identify a "radio-flavored" favorite — i.e. a stream
     * the user would expect to play directly, not a container/playlist/track.
     *
     * - x-sonosapi-stream:    TuneIn / Sonos Radio direct streams
     * - x-sonosapi-radio:     Sonos Radio (algorithmic stations like "Cool Jazz")
     * - x-sonosapi-hls:       HLS streams
     * - x-rincon-mp3radio:    plain MP3 stream URLs added as radio
     * - pndrradio:            Pandora stations
     * - hls-radio://, aac://: a few partner services
     */
    private static readonly RADIO_URI_PREFIXES = [
        'x-sonosapi-stream:',
        'x-sonosapi-radio:',
        'x-sonosapi-hls:',
        'x-rincon-mp3radio:',
        'pndrradio:',
        'hls-radio:',
        'aac:',
    ];

    private isRadioUri(uri: string | undefined): boolean {
        if (!uri) return false;
        const lower = uri.toLowerCase();
        return ContentDirectoryService.RADIO_URI_PREFIXES.some(p => lower.startsWith(p));
    }

    /**
     * Get favorite radio stations.
     *
     * On S2 systems, radio stations added via the Sonos app land in the
     * generic favorites container `FV:2`, not the legacy "My Radio Stations"
     * container `R:0/0` (which was for the old pre-S2 "My Radio" feature
     * and is typically empty on modern Sonos). We query both, filter `FV:2`
     * down to items whose resource URI looks like a radio stream, dedupe
     * by URI, and return a merged list. Pagination is applied in-memory
     * against the merged set — radio-favorites lists are tiny (<<100 items)
     * so this is fine.
     */
    async getFavoriteRadioStations(options: BrowseOptions = {}): Promise<SearchResult> {
        const { startIndex = 0, count = 100 } = options;

        // Fetch both sources with generous counts; favorites are small.
        const fetchCount = 1000;
        const [legacy, favorites] = await Promise.all([
            this.browse(this.getSearchTypeObjectId('radio_stations'), {
                startIndex: 0,
                count: fetchCount,
            }),
            this.browse(this.getSearchTypeObjectId('sonos_favorites'), {
                startIndex: 0,
                count: fetchCount,
            }),
        ]);

        // Keep only radio-flavored items from FV:2 (it also contains
        // playlists, tracks, and library shortcuts).
        const radioFavorites = favorites.items.filter(item =>
            this.isRadioUri(item.resources[0]?.uri)
        );

        // Dedupe by URI, preferring legacy R:0/0 entries first so their
        // (typically simpler) ids/titles win on collisions.
        const seen = new Set<string>();
        const merged: DidlObject[] = [];
        for (const item of [...legacy.items, ...radioFavorites]) {
            const uri = item.resources[0]?.uri ?? `__no-uri__:${item.id}`;
            if (seen.has(uri)) continue;
            seen.add(uri);
            merged.push(item);
        }

        const total = merged.length;
        const sliced = merged.slice(startIndex, startIndex + count);

        return {
            items: sliced,
            total,
            returned: sliced.length,
        };
    }

    /**
     * Get favorite radio shows
     * @param options - Browse options
     * @returns Search result with radio shows
     */
    async getFavoriteRadioShows(options: BrowseOptions = {}): Promise<SearchResult> {
        return this.browse(this.getSearchTypeObjectId('radio_shows'), options);
    }

    /**
     * Search for music in the library.
     *
     * Sonos's UPnP ContentDirectory Search() action is unreliable for
     * library queries — most criteria return 0 even on a fully-indexed
     * share. The pattern Sonos's own app (and SoCo) uses is Browse()
     * against a container ID of the form `<base>:<term>` (e.g.
     * `A:ARTIST:sting`), which returns containers whose name contains
     * `<term>` (case-insensitive substring match).
     */
    async search(
        searchType: SearchType,
        searchTerm: string,
        options: BrowseOptions = {}
    ): Promise<SearchResult> {
        const baseObjectId = this.getSearchTypeObjectId(searchType);
        const searchObjectId = `${baseObjectId}:${searchTerm}`;
        return this.browse(searchObjectId, options);
    }

    /**
     * Browse subcategories (e.g., get albums for an artist)
     * @param parentObjectId - The parent object ID (from a previous browse)
     * @param options - Browse options
     * @returns Search result
     */
    async browseSubcategory(parentObjectId: string, options: BrowseOptions = {}): Promise<SearchResult> {
        return this.browse(parentObjectId, options);
    }

    /**
     * Get all items with automatic pagination
     * @param objectId - The object ID to browse
     * @param maxItems - Maximum items to fetch (default: 1000)
     * @returns All items
     */
    async getAll(objectId: string, maxItems = 1000): Promise<DidlObject[]> {
        const allItems: DidlObject[] = [];
        let startIndex = 0;
        const pageSize = 100;

        while (allItems.length < maxItems) {
            const result = await this.browse(objectId, {
                startIndex,
                count: pageSize,
            });

            if (result.items.length === 0) {
                break;
            }

            allItems.push(...result.items);

            if (result.returned < pageSize || allItems.length >= result.total) {
                break;
            }

            startIndex += result.returned;
        }

        return allItems.slice(0, maxItems);
    }

    /**
     * Get music library shares
     * @returns List of share paths
     */
    async getShares(): Promise<string[]> {
        const result = await this.browse(this.getSearchTypeObjectId('share'));
        return result.items.map(item => item.title || '').filter(Boolean);
    }

    /**
     * Check if library is updating
     * @returns True if library is updating
     */
    async isLibraryUpdating(): Promise<boolean> {
        const body = RequestBuilder.buildSimpleBody({});
        const response = await this.callAction('GetShareIndexInProgress', body);

        if (!response.success || !response.body) {
            return false;
        }

        const isIndexing = XmlParser.extractValue(response.body, 'IsIndexing') ?? '0';
        return isIndexing === '1';
    }

    /**
     * Start a library update/scan
     * @returns True if update started successfully
     */
    async startLibraryUpdate(): Promise<boolean> {
        const body = RequestBuilder.buildSimpleBody({
            AlbumArtistDisplayOption: '',
        });

        const response = await this.callAction('RefreshShareIndex', body);
        return response.success;
    }
}
