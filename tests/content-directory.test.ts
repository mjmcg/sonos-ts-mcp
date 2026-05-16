import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentDirectoryService } from '../src/services/content-directory.js';
import type { SonosDevice } from '../src/types/sonos.js';

// Type for testing private methods
type TestableContentDirectoryService = ContentDirectoryService & {
    callAction: (action: string, body: string) => Promise<{ success: boolean; body?: string }>;
};

describe('ContentDirectoryService', () => {
    let service: ContentDirectoryService;
    let mockDevice: SonosDevice;

    beforeEach(() => {
        mockDevice = {
            uuid: 'RINCON_TEST123',
            ip: '192.168.1.100',
            port: 1400,
            location: 'http://192.168.1.100:1400/xml/device_description.xml',
        };
        service = new ContentDirectoryService(mockDevice);
    });

    describe('Search Type Object IDs', () => {
        it('should return correct object ID for artists', async () => {
            const mockResponse = {
                success: true,
                body: `<Result>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</Result><TotalMatches>0</TotalMatches><NumberReturned>0</NumberReturned>`,
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            await service.getArtists();
            expect((service as unknown as TestableContentDirectoryService).callAction).toHaveBeenCalledWith(
                'Browse',
                expect.stringContaining('A:ARTIST')
            );
        });

        it('should return correct object ID for albums', async () => {
            const mockResponse = {
                success: true,
                body: `<Result>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</Result><TotalMatches>0</TotalMatches><NumberReturned>0</NumberReturned>`,
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            await service.getAlbums();
            expect((service as unknown as TestableContentDirectoryService).callAction).toHaveBeenCalledWith(
                'Browse',
                expect.stringContaining('A:ALBUM')
            );
        });

        it('should return correct object ID for tracks', async () => {
            const mockResponse = {
                success: true,
                body: `<Result>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</Result><TotalMatches>0</TotalMatches><NumberReturned>0</NumberReturned>`,
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            await service.getTracks();
            expect((service as unknown as TestableContentDirectoryService).callAction).toHaveBeenCalledWith(
                'Browse',
                expect.stringContaining('A:TRACKS')
            );
        });

        it('should return correct object ID for genres', async () => {
            const mockResponse = {
                success: true,
                body: `<Result>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</Result><TotalMatches>0</TotalMatches><NumberReturned>0</NumberReturned>`,
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            await service.getGenres();
            expect((service as unknown as TestableContentDirectoryService).callAction).toHaveBeenCalledWith(
                'Browse',
                expect.stringContaining('A:GENRE')
            );
        });

        it('should return correct object ID for Sonos playlists', async () => {
            const mockResponse = {
                success: true,
                body: `<Result>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</Result><TotalMatches>0</TotalMatches><NumberReturned>0</NumberReturned>`,
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            await service.getSonosPlaylists();
            expect((service as unknown as TestableContentDirectoryService).callAction).toHaveBeenCalledWith(
                'Browse',
                expect.stringContaining('SQ:')
            );
        });
    });

    describe('browse', () => {
        it('should browse with default options', async () => {
            const mockResponse = {
                success: true,
                body: `<Result>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</Result><TotalMatches>10</TotalMatches><NumberReturned>10</NumberReturned><UpdateID>5</UpdateID>`,
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            const result = await service.browse('Q:0');

            expect(result.total).toBe(10);
            expect(result.returned).toBe(10);
            expect(result.updateId).toBe(5);
        });

        it('should browse with custom options', async () => {
            const mockResponse = {
                success: true,
                body: `<Result>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</Result><TotalMatches>100</TotalMatches><NumberReturned>20</NumberReturned>`,
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            await service.browse('A:ARTIST', {
                startIndex: 10,
                count: 20,
                filter: 'dc:title',
                sortCriteria: '+dc:title',
            });

            expect((service as unknown as TestableContentDirectoryService).callAction).toHaveBeenCalledWith(
                'Browse',
                expect.stringContaining('<StartingIndex>10</StartingIndex>')
            );
        });

        it('should handle empty results', async () => {
            const mockResponse = {
                success: true,
                body: `<Result></Result><TotalMatches>0</TotalMatches><NumberReturned>0</NumberReturned>`,
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            const result = await service.browse('Q:0');

            expect(result.items).toEqual([]);
            expect(result.total).toBe(0);
            expect(result.returned).toBe(0);
        });

        it('should handle failed requests', async () => {
            const mockResponse = {
                success: false,
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            const result = await service.browse('Q:0');

            expect(result.items).toEqual([]);
            expect(result.total).toBe(0);
            expect(result.returned).toBe(0);
        });
    });

    describe('browseMetadata', () => {
        it('should browse metadata for an object', async () => {
            const mockResponse = {
                success: true,
                body: `<Result>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</Result>`,
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            await service.browseMetadata('S:1234');

            expect((service as unknown as TestableContentDirectoryService).callAction).toHaveBeenCalledWith(
                'Browse',
                expect.stringContaining('BrowseMetadata')
            );
        });
    });

    describe('search', () => {
        it('should browse the prefixed container for artists', async () => {
            const mockResponse = {
                success: true,
                body: `<Result>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</Result><TotalMatches>5</TotalMatches><NumberReturned>5</NumberReturned>`,
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            const result = await service.search('artists', 'Beatles');

            expect(result.total).toBe(5);
            expect((service as unknown as TestableContentDirectoryService).callAction).toHaveBeenCalledWith(
                'Browse',
                expect.stringContaining('A:ARTIST:Beatles')
            );
        });

        it('should preserve raw search term in the container id', async () => {
            const mockResponse = {
                success: true,
                body: `<Result>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</Result><TotalMatches>0</TotalMatches><NumberReturned>0</NumberReturned>`,
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            await service.search('artists', 'AC"DC');

            // RequestBuilder XML-escapes the body, so quotes appear as &quot;
            expect((service as unknown as TestableContentDirectoryService).callAction).toHaveBeenCalledWith(
                'Browse',
                expect.stringContaining('A:ARTIST:AC&quot;DC')
            );
        });

        it('should browse the prefixed container for albums', async () => {
            const mockResponse = {
                success: true,
                body: `<Result>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</Result><TotalMatches>0</TotalMatches><NumberReturned>0</NumberReturned>`,
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            await service.search('albums', 'Black Album');

            expect((service as unknown as TestableContentDirectoryService).callAction).toHaveBeenCalledWith(
                'Browse',
                expect.stringContaining('A:ALBUM:Black Album')
            );
        });
    });

    describe('getFavoriteRadioStations', () => {
        // Build a Browse response body wrapping DIDL-Lite XML.
        // The real flow: Sonos returns DIDL-Lite XML-escaped inside <Result>;
        // ContentDirectoryService unescapes it before calling fromDidlString.
        function buildBrowseBody(didl: string, total: number): string {
            const escaped = didl
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
            return `<Result>${escaped}</Result><TotalMatches>${total}</TotalMatches><NumberReturned>${total}</NumberReturned>`;
        }

        function didlItem(id: string, parentId: string, title: string, uri: string | null, upnpClass: string): string {
            const resTag = uri ? `<res>${uri.replace(/&/g, '&amp;')}</res>` : '';
            return `<item id="${id}" parentID="${parentId}" restricted="true"><dc:title>${title}</dc:title>${resTag}<upnp:class>${upnpClass}</upnp:class></item>`;
        }

        const DIDL_OPEN = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">';
        const DIDL_CLOSE = '</DIDL-Lite>';

        it('should query both R:0/0 and FV:2', async () => {
            const callActionSpy = vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction')
                .mockResolvedValue({
                    success: true,
                    body: buildBrowseBody(`${DIDL_OPEN}${DIDL_CLOSE}`, 0),
                });

            await service.getFavoriteRadioStations();

            const calls = callActionSpy.mock.calls;
            const bodies = calls.map(c => c[1]);
            expect(bodies.some(b => b.includes('R:0/0'))).toBe(true);
            expect(bodies.some(b => b.includes('FV:2'))).toBe(true);
        });

        it('should filter FV:2 to radio-flavored URIs only', async () => {
            const favoritesDidl = `${DIDL_OPEN}${[
                didlItem('FV:2/65', 'FV:2', 'Cool Jazz', 'x-sonosapi-radio:user_channel?sid=188', 'object.itemobject.item.sonos-favorite'),
                didlItem('FV:2/74', 'FV:2', 'Library', null, 'object.itemobject.item.sonos-favorite'),
                didlItem('FV:2/75', 'FV:2', 'Some Playlist', 'file:///jffs/settings/savedqueues.rsq#5', 'object.itemobject.item.sonos-favorite'),
            ].join('')}${DIDL_CLOSE}`;

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction')
                .mockImplementation(async (_action: string, body: string) => {
                    if (body.includes('R:0/0')) {
                        return { success: true, body: buildBrowseBody(`${DIDL_OPEN}${DIDL_CLOSE}`, 0) };
                    }
                    if (body.includes('FV:2')) {
                        return { success: true, body: buildBrowseBody(favoritesDidl, 3) };
                    }
                    return { success: true, body: '' };
                });

            const result = await service.getFavoriteRadioStations();

            expect(result.items.length).toBe(1);
            expect(result.items[0].title).toBe('Cool Jazz');
        });

        it('should merge legacy R:0/0 and radio-flavored FV:2 items', async () => {
            const legacyDidl = `${DIDL_OPEN}${didlItem('R:0/0/1', 'R:0/0', 'Legacy Radio', 'x-sonosapi-stream:s12345?sid=254', 'object.item.audioItem.audioBroadcast')}${DIDL_CLOSE}`;
            const favoritesDidl = `${DIDL_OPEN}${didlItem('FV:2/65', 'FV:2', 'Cool Jazz', 'x-sonosapi-radio:user_channel?sid=188', 'object.itemobject.item.sonos-favorite')}${DIDL_CLOSE}`;

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction')
                .mockImplementation(async (_action: string, body: string) => {
                    if (body.includes('R:0/0')) {
                        return { success: true, body: buildBrowseBody(legacyDidl, 1) };
                    }
                    if (body.includes('FV:2')) {
                        return { success: true, body: buildBrowseBody(favoritesDidl, 1) };
                    }
                    return { success: true, body: '' };
                });

            const result = await service.getFavoriteRadioStations();

            expect(result.items.length).toBe(2);
            expect(result.total).toBe(2);
            const titles = result.items.map(i => i.title);
            expect(titles).toContain('Legacy Radio');
            expect(titles).toContain('Cool Jazz');
        });

        it('should dedupe by URI; legacy R:0/0 wins on collision', async () => {
            const sharedUri = 'x-sonosapi-stream:s12345?sid=254';
            const legacyDidl = `${DIDL_OPEN}${didlItem('R:0/0/1', 'R:0/0', 'Legacy Title', sharedUri, 'object.item.audioItem.audioBroadcast')}${DIDL_CLOSE}`;
            const favoritesDidl = `${DIDL_OPEN}${didlItem('FV:2/99', 'FV:2', 'Favorite Title', sharedUri, 'object.itemobject.item.sonos-favorite')}${DIDL_CLOSE}`;

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction')
                .mockImplementation(async (_action: string, body: string) => {
                    if (body.includes('R:0/0')) {
                        return { success: true, body: buildBrowseBody(legacyDidl, 1) };
                    }
                    if (body.includes('FV:2')) {
                        return { success: true, body: buildBrowseBody(favoritesDidl, 1) };
                    }
                    return { success: true, body: '' };
                });

            const result = await service.getFavoriteRadioStations();

            expect(result.items.length).toBe(1);
            expect(result.items[0].title).toBe('Legacy Title');
        });

        it('should work when R:0/0 is empty (typical S2 case)', async () => {
            const favoritesDidl = `${DIDL_OPEN}${didlItem('FV:2/65', 'FV:2', 'Cool Jazz', 'x-sonosapi-radio:user_channel?sid=188', 'object.itemobject.item.sonos-favorite')}${DIDL_CLOSE}`;

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction')
                .mockImplementation(async (_action: string, body: string) => {
                    if (body.includes('R:0/0')) {
                        return { success: true, body: buildBrowseBody(`${DIDL_OPEN}${DIDL_CLOSE}`, 0) };
                    }
                    if (body.includes('FV:2')) {
                        return { success: true, body: buildBrowseBody(favoritesDidl, 1) };
                    }
                    return { success: true, body: '' };
                });

            const result = await service.getFavoriteRadioStations();

            expect(result.items.length).toBe(1);
            expect(result.items[0].title).toBe('Cool Jazz');
        });
    });

    describe('getAll', () => {
        it('should stop pagination when no more items', async () => {
            const mockResponse = {
                success: true,
                body: `<Result>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</Result><TotalMatches>150</TotalMatches><NumberReturned>0</NumberReturned>`,
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            const result = await service.getAll('A:ARTIST');

            expect(result.length).toBe(0);
            expect((service as unknown as TestableContentDirectoryService).callAction).toHaveBeenCalledTimes(1);
        });

        it('should respect maxItems limit', async () => {
            const mockResponse = {
                success: true,
                body: `<Result>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</Result><TotalMatches>200</TotalMatches><NumberReturned>100</NumberReturned>`,
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            await service.getAll('A:ARTIST', 50);

            expect((service as unknown as TestableContentDirectoryService).callAction).toHaveBeenCalledTimes(1);
        });
    });

    describe('isLibraryUpdating', () => {
        it('should return true when library is updating', async () => {
            const mockResponse = {
                success: true,
                body: '<IsIndexing>1</IsIndexing>',
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            const result = await service.isLibraryUpdating();

            expect(result).toBe(true);
        });

        it('should return false when library is not updating', async () => {
            const mockResponse = {
                success: true,
                body: '<IsIndexing>0</IsIndexing>',
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            const result = await service.isLibraryUpdating();

            expect(result).toBe(false);
        });
    });

    describe('startLibraryUpdate', () => {
        it('should start library update', async () => {
            const mockResponse = {
                success: true,
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            const result = await service.startLibraryUpdate();

            expect(result).toBe(true);
            expect((service as unknown as TestableContentDirectoryService).callAction).toHaveBeenCalledWith(
                'RefreshShareIndex',
                expect.any(String)
            );
        });
    });

    describe('getShares', () => {
        it('should return empty array when no shares found', async () => {
            const mockResponse = {
                success: true,
                body: `<Result>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</Result><TotalMatches>0</TotalMatches><NumberReturned>0</NumberReturned>`,
            };

            vi.spyOn(service as unknown as TestableContentDirectoryService, 'callAction').mockResolvedValue(mockResponse);

            const result = await service.getShares();

            expect(result).toEqual([]);
        });
    });
});
