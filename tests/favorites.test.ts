import { describe, it, expect } from 'vitest';
import {
    classifyFavoriteUri,
    isContainerFavoriteUri,
    resolveFavoriteUri,
} from '../src/services/favorites.js';
import { DidlFavorite } from '../src/didl/didl-item.js';

describe('classifyFavoriteUri', () => {
    it('classifies container schemes as "container"', () => {
        expect(classifyFavoriteUri('x-rincon-cpcontainer:1004206cspotify%3aalbum%3a...')).toBe('container');
        expect(classifyFavoriteUri('x-rincon-playlist:RINCON_123#A:PLAYLISTS/My%20Playlist')).toBe('container');
    });

    it('classifies known radio-stream schemes as "stream"', () => {
        expect(classifyFavoriteUri('x-sonosapi-stream:s12345?sid=254')).toBe('stream');
        expect(classifyFavoriteUri('x-sonosapi-radio:user_channel%3a5f2e9570?sid=188')).toBe('stream');
        expect(classifyFavoriteUri('x-sonosapi-hls:foo')).toBe('stream');
        expect(classifyFavoriteUri('x-rincon-mp3radio:http://example.com/stream.mp3')).toBe('stream');
        expect(classifyFavoriteUri('pndrradio:1234')).toBe('stream');
        expect(classifyFavoriteUri('hls-radio:foo')).toBe('stream');
        expect(classifyFavoriteUri('aac:foo')).toBe('stream');
    });

    it('classifies everything else as "track"', () => {
        // Spotify single track, library files, generic http audio.
        expect(classifyFavoriteUri('x-sonos-spotify:spotify%3atrack%3aabc')).toBe('track');
        expect(classifyFavoriteUri('x-file-cifs://server/share/song.mp3')).toBe('track');
        expect(classifyFavoriteUri('http://example.com/song.mp3')).toBe('track');
    });

    it('returns "unknown" for missing URIs', () => {
        expect(classifyFavoriteUri(undefined)).toBe('unknown');
        expect(classifyFavoriteUri('')).toBe('unknown');
    });

    it('is case-insensitive', () => {
        expect(classifyFavoriteUri('X-RINCON-CPCONTAINER:abc')).toBe('container');
        expect(classifyFavoriteUri('X-SonosAPI-Stream:s1')).toBe('stream');
    });
});

describe('isContainerFavoriteUri', () => {
    it('returns true only for container schemes', () => {
        expect(isContainerFavoriteUri('x-rincon-cpcontainer:abc')).toBe(true);
        expect(isContainerFavoriteUri('x-rincon-playlist:abc')).toBe(true);
        expect(isContainerFavoriteUri('x-sonosapi-stream:s1')).toBe(false);
        expect(isContainerFavoriteUri('http://example.com/song.mp3')).toBe(false);
        expect(isContainerFavoriteUri(undefined)).toBe(false);
        expect(isContainerFavoriteUri('')).toBe(false);
    });
});

describe('resolveFavoriteUri', () => {
    it('returns the top-level <res> URI when present', async () => {
        const fav = new DidlFavorite({
            id: 'FV:2/65',
            parentId: 'FV:2',
            title: 'Cool Jazz',
            resources: [{ uri: 'x-sonosapi-radio:user_channel?sid=188', protocolInfo: '' }],
        });

        const uri = await resolveFavoriteUri(fav);
        expect(uri).toBe('x-sonosapi-radio:user_channel?sid=188');
    });

    it('falls back to URI inside resMD when top-level <res> is empty', async () => {
        // "Library"-style favorite: no top-level res, but resMD wraps an
        // inner DIDL item with the real container URI.
        const innerDidl = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="A:" parentID="-1" restricted="true"><dc:title>Library</dc:title><res>x-rincon-cpcontainer:0006206cA:</res><upnp:class>object.container</upnp:class></item></DIDL-Lite>';

        const fav = new DidlFavorite({
            id: 'FV:2/74',
            parentId: 'FV:2',
            title: 'Library',
            resourceMetaData: innerDidl,
        });

        const uri = await resolveFavoriteUri(fav);
        expect(uri).toBe('x-rincon-cpcontainer:0006206cA:');
    });

    it('returns undefined when neither <res> nor resMD has a URI', async () => {
        const fav = new DidlFavorite({
            id: 'FV:2/99',
            parentId: 'FV:2',
            title: 'Broken',
        });

        const uri = await resolveFavoriteUri(fav);
        expect(uri).toBeUndefined();
    });

    it('returns undefined when resMD is malformed', async () => {
        const fav = new DidlFavorite({
            id: 'FV:2/99',
            parentId: 'FV:2',
            title: 'Broken',
            resourceMetaData: '<not-valid-didl-at-all',
        });

        const uri = await resolveFavoriteUri(fav);
        expect(uri).toBeUndefined();
    });
});
