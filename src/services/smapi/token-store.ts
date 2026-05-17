/**
 * File-backed SMAPI token store.
 *
 * Sonos's SMAPI auth flow returns an `authToken` + `privateKey` pair
 * scoped to (service, household). We persist them so the user only has
 * to run the link flow once per service. Storage is a single JSON file
 * under MCP_DATA_DIR, which is already mounted as a volume in the
 * compose stack — survives container rebuilds.
 *
 * Schema:
 *
 *   {
 *     "version": 1,
 *     "tokens": {
 *       "<householdId>::<serviceId>": {
 *         "serviceId": 204,
 *         "serviceName": "Apple Music",
 *         "householdId": "Sonos_xxxxx",
 *         "authToken": "...",
 *         "privateKey": "...",
 *         "linkCode": "...",      // for audit / re-link only
 *         "deviceId": "...",      // the player used to link
 *         "updatedAt": "2026-05-17T..."
 *       }
 *     }
 *   }
 *
 * File mode 0600. Atomic writes (tmp + rename) so a crashed process
 * doesn't leave the user with a half-written file and a bricked
 * household.
 */

import { promises as fs } from 'fs';
import { dirname, join } from 'path';

export interface SmapiStoredToken {
    serviceId: number;
    serviceName: string;
    householdId: string;
    authToken: string;
    privateKey: string;
    linkCode?: string;
    deviceId?: string;
    updatedAt: string;
}

interface StoreFile {
    version: 1;
    tokens: Record<string, SmapiStoredToken>;
}

const FILE_VERSION = 1;
const FILE_NAME = 'smapi-tokens.json';

function dataDir(): string {
    const fromEnv = process.env.MCP_DATA_DIR;
    return fromEnv && fromEnv.trim() ? fromEnv.trim() : '/data';
}

function storePath(): string {
    return join(dataDir(), FILE_NAME);
}

function keyFor(serviceId: number, householdId: string): string {
    return `${householdId}::${serviceId}`;
}

async function readFileOrEmpty(): Promise<StoreFile> {
    try {
        const raw = await fs.readFile(storePath(), 'utf8');
        const parsed = JSON.parse(raw) as StoreFile;
        if (parsed && typeof parsed === 'object' && parsed.version === FILE_VERSION && parsed.tokens) {
            return parsed;
        }
        // Unknown version — log and start fresh rather than crash.
        console.error(
            `[SMAPI tokens] ignoring ${storePath()} (unknown schema version)`
        );
        return { version: FILE_VERSION, tokens: {} };
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            return { version: FILE_VERSION, tokens: {} };
        }
        throw err;
    }
}

async function writeFileAtomic(data: StoreFile): Promise<void> {
    const target = storePath();
    const dir = dirname(target);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${target}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, target);
}

export class SmapiTokenStore {
    async load(serviceId: number, householdId: string): Promise<SmapiStoredToken | null> {
        const file = await readFileOrEmpty();
        return file.tokens[keyFor(serviceId, householdId)] ?? null;
    }

    async save(token: SmapiStoredToken): Promise<void> {
        const file = await readFileOrEmpty();
        file.tokens[keyFor(token.serviceId, token.householdId)] = {
            ...token,
            updatedAt: token.updatedAt || new Date().toISOString(),
        };
        await writeFileAtomic(file);
    }

    async delete(serviceId: number, householdId: string): Promise<boolean> {
        const file = await readFileOrEmpty();
        const k = keyFor(serviceId, householdId);
        if (!(k in file.tokens)) return false;
        delete file.tokens[k];
        await writeFileAtomic(file);
        return true;
    }

    async list(householdId?: string): Promise<SmapiStoredToken[]> {
        const file = await readFileOrEmpty();
        const all = Object.values(file.tokens);
        return householdId ? all.filter(t => t.householdId === householdId) : all;
    }

    /**
     * Convenience for the SMAPIClient `onTokenRefresh` callback:
     * persists a refreshed pair without requiring the caller to
     * reassemble the full SmapiStoredToken (we look up the existing
     * record to preserve serviceName/deviceId/linkCode).
     */
    async refresh(
        serviceId: number,
        householdId: string,
        pair: { token: string; key: string }
    ): Promise<void> {
        const existing = await this.load(serviceId, householdId);
        await this.save({
            serviceId,
            serviceName: existing?.serviceName ?? `service-${serviceId}`,
            householdId,
            authToken: pair.token,
            privateKey: pair.key,
            linkCode: existing?.linkCode,
            deviceId: existing?.deviceId,
            updatedAt: new Date().toISOString(),
        });
    }

    /** Resolve the on-disk path (for diagnostics and tests). */
    path(): string {
        return storePath();
    }
}

/** Module-level singleton used by the production handlers. */
let singleton: SmapiTokenStore | null = null;
export function getTokenStore(): SmapiTokenStore {
    if (!singleton) singleton = new SmapiTokenStore();
    return singleton;
}

/** Test hook: replace the singleton. */
export function setTokenStoreForTesting(store: SmapiTokenStore | null): void {
    singleton = store;
}
