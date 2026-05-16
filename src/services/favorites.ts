/**
 * Helpers for classifying and playing Sonos Favorites (FV:2).
 *
 * Sonos Favorites are heterogeneous — they can be radio streams (TuneIn,
 * Sonos Radio), service-side containers (Spotify/Apple album, Sonos
 * playlist), or single tracks. Playing them correctly requires picking
 * between two transport flows:
 *
 *   - Container favorites (`x-rincon-cpcontainer:` and a handful of other
 *     service-side container schemes) cannot be set as the AVTransport URI
 *     directly — Sonos rejects them with UPnP 714 "Illegal MIME type". The
 *     working pattern (used by the Sonos app and by sonoscli) is:
 *       1. RemoveAllTracksFromQueue
 *       2. AddURIToQueue with the favorite's <r:resMD> as metadata
 *       3. Seek + Play from the first enqueued track
 *
 *   - Stream / single-track favorites are played directly via
 *     SetAVTransportURI(uri, resMD). The queue is left alone — this matches
 *     the Sonos app's behavior for radio favorites.
 *
 * The URI we play with isn't always the favorite's top-level `<res>` — some
 * favorites (notably library shortcuts) embed the real URI inside the
 * `<r:resMD>` DIDL. `resolveFavoriteUri` handles that fallback.
 */

import type { DidlObject } from '../didl/didl-object.js';
import { fromDidlString } from '../didl/didl-parser.js';

export type FavoritePlayableAs = 'container' | 'stream' | 'track' | 'unknown';

/**
 * URI schemes that designate a service-side container (album, playlist,
 * browsable item). These must be enqueued rather than set as transport URI.
 */
const CONTAINER_URI_PREFIXES = [
    'x-rincon-cpcontainer:',
    'x-rincon-playlist:',
];

/**
 * URI schemes that designate a radio-flavored stream (TuneIn, Sonos Radio,
 * direct MP3/AAC/HLS streams, partner services like Pandora). These play
 * directly via SetAVTransportURI.
 */
const STREAM_URI_PREFIXES = [
    'x-sonosapi-stream:',
    'x-sonosapi-radio:',
    'x-sonosapi-hls:',
    'x-sonosapi-hls-static:',
    'x-rincon-mp3radio:',
    'pndrradio:',
    'hls-radio:',
    'aac:',
];

export function isContainerFavoriteUri(uri: string | undefined): boolean {
    if (!uri) return false;
    const lower = uri.toLowerCase();
    return CONTAINER_URI_PREFIXES.some(p => lower.startsWith(p));
}

export function classifyFavoriteUri(uri: string | undefined): FavoritePlayableAs {
    if (!uri) return 'unknown';
    const lower = uri.toLowerCase();
    if (CONTAINER_URI_PREFIXES.some(p => lower.startsWith(p))) return 'container';
    if (STREAM_URI_PREFIXES.some(p => lower.startsWith(p))) return 'stream';
    return 'track';
}

/**
 * Resolve the effective playable URI for a favorite.
 *
 * Returns the top-level `<res>` URI when present; otherwise parses the
 * inner DIDL inside `<r:resMD>` (`resourceMetaData`) and returns its URI.
 * Some library-shortcut favorites ("Library", "My History") only have a
 * URI inside the inner resMD.
 */
export async function resolveFavoriteUri(item: DidlObject): Promise<string | undefined> {
    const direct = item.resources[0]?.uri;
    if (direct) return direct;

    // resourceMetaData lives on DidlFavorite (and other classes that
    // override `<r:resourceMetaData>`), but every DIDL element parsed from
    // FV:2 carries it as a property. Read via the base accessor so we
    // don't need to narrow the static type.
    const resMd = item.getProperty('resourceMetaData') as string | undefined;
    if (!resMd) return undefined;

    try {
        const inner = await fromDidlString(resMd);
        return inner[0]?.resources[0]?.uri;
    } catch {
        return undefined;
    }
}
