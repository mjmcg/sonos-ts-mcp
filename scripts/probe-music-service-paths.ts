#!/usr/bin/env tsx
/**
 * Read-only probe to decide how to interact with already-linked music
 * services (Apple Music, AccuRadio, SiriusXM) without doing SMAPI auth
 * from the MCP server.
 *
 * Three approaches under test:
 *   A. MusicServices.GetSessionId → use the returned session in SMAPI
 *      calls. Piggybacks on the player's already-linked credentials.
 *   B. ContentDirectory.Browse on the player. Player handles SMAPI
 *      internally with its own stored tokens.
 *   C. Inspect existing favorites/queue to see what service URIs the
 *      player already speaks fluently (informs whatever path we pick).
 *
 * Read-only: no SetAVTransportURI, no auth attempts, no token writes.
 *
 * Usage:
 *   SONOS_IP=192.168.x.y npx tsx scripts/probe-music-service-paths.ts
 *   (or omit SONOS_IP to SSDP-discover)
 */

import { SsdpClient } from '../src/discovery/ssdp-client.js';
import { DeviceRegistry } from '../src/discovery/device-registry.js';
import { MusicServicesService } from '../src/services/music-services.js';
import { ContentDirectoryService } from '../src/services/content-directory.js';
import { SMAPIClient } from '../src/services/smapi-client.js';
import { SystemPropertiesService } from '../src/services/system-properties.js';
import { DevicePropertiesService } from '../src/services/device-properties.js';
import type { SonosDevice } from '../src/types/sonos.js';
import type { MusicServiceDescriptor } from '../src/types/music-services.js';

const TARGET_SERVICE_NAMES = ['Apple Music', 'AccuRadio', 'SiriusXM', 'Sonos Radio'];

const banner = (s: string) => console.log(`\n${'='.repeat(70)}\n${s}\n${'='.repeat(70)}`);
const sub = (s: string) => console.log(`\n--- ${s} ---`);

async function resolveDevice(): Promise<SonosDevice> {
    const envIp = process.env.SONOS_IP;
    if (envIp) {
        return {
            uuid: 'PROBE',
            name: 'probe',
            ip: envIp,
            port: 1400,
            location: `http://${envIp}:1400/xml/device_description.xml`,
        };
    }
    console.log('Discovering Sonos players via SSDP (5s)…');
    const client = new SsdpClient();
    const registry = new DeviceRegistry();
    const responses = await client.discover(5000);
    for (const r of responses) registry.addFromDiscovery(r);
    const devices = registry.getAllDevices();
    if (devices.length === 0) {
        throw new Error('No Sonos devices discovered. Set SONOS_IP=<player-ip> and rerun.');
    }
    console.log(`Found ${devices.length} player(s); using ${devices[0]!.name ?? devices[0]!.ip}`);
    return devices[0]!;
}

async function probeContext(device: SonosDevice) {
    sub('System / device context');
    try {
        const sysProps = new SystemPropertiesService(device);
        for (const v of ['R_TrialZPSerial', 'HHID', 'HouseholdId']) {
            try {
                const val = await sysProps.getString(v);
                if (val) console.log(`  ${v} = ${val}`);
            } catch { /* ignore — variable may not exist */ }
        }
        const devProps = new DevicePropertiesService(device);
        try {
            const hh = await devProps.getHouseholdID();
            if (hh) console.log(`  HouseholdID = ${hh}`);
        } catch { /* ignore */ }
    } catch (e) {
        console.log(`  (context probe error: ${(e as Error).message})`);
    }
}

async function probeServices(device: SonosDevice): Promise<MusicServiceDescriptor[]> {
    sub('MusicServices.ListAvailableServices');
    const ms = new MusicServicesService(device);
    const services = await ms.listAvailableServices();
    console.log(`  Total services: ${services.length}`);
    const targets = services.filter(s =>
        TARGET_SERVICE_NAMES.some(n => s.name.toLowerCase().includes(n.toLowerCase()))
    );
    for (const s of targets) {
        console.log(`  • ${s.name} (id=${s.id}, authType=${s.authType})`);
    }
    return targets;
}

async function probeOptionA_GetSessionId(
    device: SonosDevice,
    services: MusicServiceDescriptor[],
) {
    banner('OPTION A — MusicServices.GetSessionId + SMAPI');
    const ms = new MusicServicesService(device);
    for (const svc of services) {
        sub(`${svc.name} (id=${svc.id})`);
        // Try a few candidate "usernames". The player's stored credentials
        // are keyed by something; we don't know what until we ask.
        const candidates = ['', '0', svc.name];
        let sessionId: string | null = null;
        for (const u of candidates) {
            try {
                sessionId = await ms.getSessionId(svc.id, u);
                console.log(`  GetSessionId(username=${JSON.stringify(u)}) → ${sessionId ?? 'null'}`);
                if (sessionId) break;
            } catch (e) {
                console.log(`  GetSessionId(username=${JSON.stringify(u)}) → error: ${(e as Error).message}`);
            }
        }
        if (!sessionId) {
            console.log('  → No session id obtainable; option A unlikely for this service.');
            continue;
        }
        // Try to use the session id as a SMAPI loginToken. We don't know
        // the right shape — try the simplest mapping (token=sessionId,
        // empty key) and report what comes back.
        try {
            const client = new SMAPIClient(svc, {
                deviceId: device.uuid,
                loginToken: { token: sessionId, key: '', householdId: '' },
            });
            const root = await client.getMetadata('root', 0, 5);
            console.log(`  SMAPI getMetadata('root') with sessionId → total=${root.total}, items=${root.items.length}`);
            if (root.items[0]) {
                console.log(`    first item: id=${root.items[0].id} title=${(root.items[0] as { title?: string }).title}`);
            }
        } catch (e) {
            console.log(`  SMAPI call with sessionId → error: ${(e as Error).message}`);
        }
    }
}

async function probeOptionB_ContentDirectory(
    device: SonosDevice,
    services: MusicServiceDescriptor[],
) {
    banner('OPTION B — ContentDirectory.Browse on the player');
    const cd = new ContentDirectoryService(device);

    const staticIds = [
        '0',           // root
        'FV:2',        // favorites (known-working sanity check)
        'R:0/0',       // radio favorites
        'SQ:',         // Sonos playlists
        'A:ALBUMARTIST', // library artists
    ];
    for (const id of staticIds) {
        sub(`Browse('${id}')`);
        try {
            const r = await cd.browse(id, { count: 8 });
            console.log(`  total=${r.total} returned=${r.returned}`);
            for (const item of r.items.slice(0, 8)) {
                const title = (item as { title?: string }).title ?? '(no title)';
                const id = (item as { id?: string }).id ?? '(no id)';
                const klass = (item as { upnpClass?: string }).upnpClass ?? '';
                console.log(`    • [${id}] ${title}   ${klass}`);
                const resources = (item as { resources?: Array<{ uri?: string }> }).resources;
                if (resources?.[0]?.uri) console.log(`        res: ${resources[0].uri}`);
            }
        } catch (e) {
            console.log(`  → error: ${(e as Error).message}`);
        }
    }

    // Try a few candidate object-ID prefixes for service-rooted browsing.
    // Sonos historically uses 'S:' for search results and service-specific
    // ids that the player itself emits in Browse responses; we don't know
    // the exact shape until we see one, so this is exploratory.
    for (const svc of services) {
        sub(`Service-rooted candidates for ${svc.name} (id=${svc.id})`);
        const candidates = [
            `S:${svc.id}`,
            `0/${svc.name}`,
            `0/Services/${svc.name}`,
            `SVC:${svc.id}`,
        ];
        for (const id of candidates) {
            try {
                const r = await cd.browse(id, { count: 3 });
                console.log(`  Browse('${id}') → total=${r.total} returned=${r.returned}`);
                for (const item of r.items.slice(0, 3)) {
                    const title = (item as { title?: string }).title ?? '(no title)';
                    const cid = (item as { id?: string }).id ?? '(no id)';
                    console.log(`    • [${cid}] ${title}`);
                }
            } catch (e) {
                console.log(`  Browse('${id}') → error: ${(e as Error).message}`);
            }
        }
    }
}

async function probeOptionC_InspectExistingURIs(device: SonosDevice) {
    banner('OPTION C — Inspect favorites/queue for service URI patterns');
    const cd = new ContentDirectoryService(device);
    for (const id of ['FV:2', 'Q:0', 'SQ:']) {
        sub(`Resource URIs under ${id}`);
        try {
            const r = await cd.browse(id, { count: 30 });
            const seenSchemes = new Set<string>();
            for (const item of r.items) {
                const resources = (item as { resources?: Array<{ uri?: string }> }).resources;
                const uri = resources?.[0]?.uri;
                if (!uri) continue;
                const scheme = uri.split(':')[0];
                if (scheme) seenSchemes.add(scheme);
                const title = (item as { title?: string }).title ?? '';
                if (/apple|accu|sirius|spotify|amazon|tidal/i.test(uri + ' ' + title)) {
                    console.log(`    HIT: ${title}`);
                    console.log(`         ${uri}`);
                }
            }
            console.log(`  schemes seen: ${Array.from(seenSchemes).join(', ') || '(none)'}`);
        } catch (e) {
            console.log(`  → error: ${(e as Error).message}`);
        }
    }
}

async function main() {
    const device = await resolveDevice();
    console.log(`\nPlayer: ${device.name ?? '(unnamed)'}  ${device.ip}:${device.port}  uuid=${device.uuid}`);
    await probeContext(device);
    const targets = await probeServices(device);

    if (targets.length === 0) {
        console.log('\nNone of the target services found on this household. Listing all:');
        const ms = new MusicServicesService(device);
        const all = await ms.listAvailableServices();
        for (const s of all) console.log(`  • ${s.name} (id=${s.id}, authType=${s.authType})`);
        return;
    }

    await probeOptionA_GetSessionId(device, targets);
    await probeOptionB_ContentDirectory(device, targets);
    await probeOptionC_InspectExistingURIs(device);

    banner('Done. Send the full output back and we decide on A / B / C.');
}

main().catch(err => {
    console.error('\nFatal:', err);
    process.exit(1);
});
