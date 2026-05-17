/**
 * Resolves the per-player context that SMAPI requires on every call.
 *
 * Sonos's SMAPI (Sonos Music API) spec requires every SOAP call to a
 * music service to include a `<credentials>` header containing at minimum
 * a `<deviceId>` and `<deviceProvider>`. For authenticated services (any
 * service with auth = DeviceLink or AppLink) the household ID is also
 * required, both inside the `<loginToken>` block and as part of the auth
 * flow itself. Without these, services either return empty results or
 * 500 with a SOAP fault — and on most modern firmware, lazy clients that
 * omit them silently get the empty-result path, which is why the
 * previous implementation looked like an auth problem.
 *
 * Resolution strategy mirrors sonoscli:
 *   1. household = DeviceProperties.GetHouseholdID()
 *   2. deviceId  = SystemProperties.GetString("R_TrialZPSerial") if set,
 *                  else the player's UDN (already cached on SonosDevice).
 *
 * Cached per-device so a steady-state browse doesn't pay the two extra
 * SOAP round-trips on every call. Cache is invalidated by re-running
 * resolveSmapiContext with `force: true`.
 */

import type { SonosDevice } from '../../types/sonos.js';
import { DevicePropertiesService } from '../device-properties.js';
import { SystemPropertiesService } from '../system-properties.js';

export interface SmapiAuthContext {
    /** Household ID, e.g. "Sonos_xxxxxxxxxxxxxxxxxxxxxx". */
    householdId: string;
    /** Per-player identifier passed in the SMAPI credentials header. */
    deviceId: string;
}

const cache = new Map<string, SmapiAuthContext>();

export function clearSmapiContextCache(): void {
    cache.clear();
}

export async function resolveSmapiContext(
    device: SonosDevice,
    options: { force?: boolean } = {}
): Promise<SmapiAuthContext> {
    const cacheKey = device.uuid || `${device.ip}:${device.port}`;
    if (!options.force) {
        const cached = cache.get(cacheKey);
        if (cached) return cached;
    }

    const deviceProps = new DevicePropertiesService(device);
    const householdId = await deviceProps.getHouseholdID();
    if (!householdId) {
        throw new Error(
            `Could not resolve household ID for device ${cacheKey}. ` +
            `SMAPI calls require GetHouseholdID to succeed; check that the ` +
            `player is reachable and that DeviceProperties:1 is exposed.`
        );
    }

    // Prefer R_TrialZPSerial when set — it's Sonos's canonical short
    // device id for service registration. Fall back to the UDN/UUID.
    const sysProps = new SystemPropertiesService(device);
    let deviceId = await sysProps.getString('R_TrialZPSerial');
    if (!deviceId) {
        deviceId = device.uuid?.trim() || null;
    }
    if (!deviceId) {
        throw new Error(
            `Could not resolve a device id for ${cacheKey}: neither ` +
            `R_TrialZPSerial nor SonosDevice.uuid is set.`
        );
    }

    const ctx: SmapiAuthContext = { householdId, deviceId };
    cache.set(cacheKey, ctx);
    return ctx;
}
