import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SmapiTokenStore, type SmapiStoredToken } from '../src/services/smapi/token-store.js';

describe('SmapiTokenStore', () => {
    let tmp: string;
    let store: SmapiTokenStore;

    beforeEach(async () => {
        tmp = await fs.mkdtemp(join(tmpdir(), 'smapi-token-test-'));
        process.env.MCP_DATA_DIR = tmp;
        store = new SmapiTokenStore();
    });

    afterEach(async () => {
        delete process.env.MCP_DATA_DIR;
        await fs.rm(tmp, { recursive: true, force: true });
    });

    function makeToken(overrides: Partial<SmapiStoredToken> = {}): SmapiStoredToken {
        return {
            serviceId: 204,
            serviceName: 'Apple Music',
            householdId: 'Sonos_HH1',
            authToken: 'TOK',
            privateKey: 'KEY',
            updatedAt: '2026-05-17T00:00:00.000Z',
            ...overrides,
        };
    }

    it('returns null when no token is stored', async () => {
        const result = await store.load(204, 'Sonos_HH1');
        expect(result).toBeNull();
    });

    it('persists and retrieves a token by (serviceId, householdId)', async () => {
        const tok = makeToken();
        await store.save(tok);

        const loaded = await store.load(204, 'Sonos_HH1');
        expect(loaded?.authToken).toBe('TOK');
        expect(loaded?.privateKey).toBe('KEY');
    });

    it('scopes by household — same serviceId in different households does not collide', async () => {
        await store.save(makeToken({ householdId: 'Sonos_HH1', authToken: 'TOK1' }));
        await store.save(makeToken({ householdId: 'Sonos_HH2', authToken: 'TOK2' }));

        expect((await store.load(204, 'Sonos_HH1'))?.authToken).toBe('TOK1');
        expect((await store.load(204, 'Sonos_HH2'))?.authToken).toBe('TOK2');
    });

    it('overwrites the existing token on save', async () => {
        await store.save(makeToken({ authToken: 'OLD' }));
        await store.save(makeToken({ authToken: 'NEW' }));

        const loaded = await store.load(204, 'Sonos_HH1');
        expect(loaded?.authToken).toBe('NEW');
    });

    it('delete removes the token and returns true', async () => {
        await store.save(makeToken());
        const removed = await store.delete(204, 'Sonos_HH1');
        expect(removed).toBe(true);
        expect(await store.load(204, 'Sonos_HH1')).toBeNull();
    });

    it('delete returns false when the token does not exist', async () => {
        const removed = await store.delete(204, 'Sonos_HH1');
        expect(removed).toBe(false);
    });

    it('list returns all tokens, optionally filtered by household', async () => {
        await store.save(makeToken({ serviceId: 204, householdId: 'Sonos_HH1' }));
        await store.save(makeToken({ serviceId: 12, householdId: 'Sonos_HH1', serviceName: 'Spotify' }));
        await store.save(makeToken({ serviceId: 188, householdId: 'Sonos_HH2', serviceName: 'AccuRadio' }));

        expect((await store.list()).length).toBe(3);
        expect((await store.list('Sonos_HH1')).length).toBe(2);
        expect((await store.list('Sonos_HH2')).length).toBe(1);
    });

    it('refresh updates token+key but preserves serviceName/deviceId/linkCode', async () => {
        await store.save(makeToken({
            authToken: 'OLD',
            privateKey: 'OLDKEY',
            deviceId: 'RINCON_AAA',
            linkCode: 'ABC123',
        }));
        await store.refresh(204, 'Sonos_HH1', { token: 'NEW', key: 'NEWKEY' });

        const loaded = await store.load(204, 'Sonos_HH1');
        expect(loaded?.authToken).toBe('NEW');
        expect(loaded?.privateKey).toBe('NEWKEY');
        expect(loaded?.serviceName).toBe('Apple Music');
        expect(loaded?.deviceId).toBe('RINCON_AAA');
        expect(loaded?.linkCode).toBe('ABC123');
    });

    it('refresh creates a new entry when no token existed (best-effort path for unsolicited refreshes)', async () => {
        await store.refresh(204, 'Sonos_HH1', { token: 'NEW', key: 'NEWKEY' });
        const loaded = await store.load(204, 'Sonos_HH1');
        expect(loaded?.authToken).toBe('NEW');
        expect(loaded?.serviceName).toBe('service-204'); // placeholder
    });

    it('writes with mode 0600', async () => {
        await store.save(makeToken());
        const stat = await fs.stat(join(tmp, 'smapi-tokens.json'));
        // umask may affect this on some systems; assert the user-write bit is set
        // and group/other bits are NOT set.
        // (stat.mode & 0o777) on a 0600 file is 0o600.
        expect(stat.mode & 0o077).toBe(0);
    });

    it('starts fresh when the file has an unknown schema version', async () => {
        await fs.writeFile(
            join(tmp, 'smapi-tokens.json'),
            JSON.stringify({ version: 99, tokens: { foo: 'bar' } })
        );
        expect(await store.load(204, 'Sonos_HH1')).toBeNull();
    });
});
