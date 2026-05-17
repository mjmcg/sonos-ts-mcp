/**
 * SMAPI authentication flow orchestrator.
 *
 * Bridges the SMAPI primitives (getDeviceLinkCode / getAppLink /
 * getDeviceAuthToken on SMAPIClient) with our token store. The MCP
 * handlers call into this rather than the client directly so that all
 * the token-persistence policy lives in one place.
 *
 * Two flows, both ending at `completeAuth(linkCode, linkDeviceId)`:
 *
 *   DeviceLink (AccuRadio, Spotify, TIDAL, …):
 *     1. beginAuth() → returns { regUrl, linkCode, linkDeviceId, kind: "devicelink" }
 *     2. User opens regUrl, types in linkCode on the partner site,
 *        approves the link.
 *     3. completeAuth() exchanges (linkCode, linkDeviceId) for an
 *        { authToken, privateKey } pair and stores it.
 *
 *   AppLink (Apple Music, SiriusXM, YouTube Music, …):
 *     1. beginAuth() → returns one of:
 *          - { regUrl, linkCode, linkDeviceId, kind: "devicelink" }
 *            (services that internally fall back to the device-link flow), or
 *          - { appUrl, kind: "applink" } (services that hand off to a
 *            partner web flow which produces a link code).
 *     2. User completes the partner flow; the partner returns a code
 *        (out-of-band — pasted back to the MCP caller).
 *     3. completeAuth(linkCode, linkDeviceId) exchanges and stores.
 */

import type { MusicServiceDescriptor } from '../../types/music-services.js';
import type { SonosDevice } from '../../types/sonos.js';
import { SMAPIClient } from '../smapi-client.js';
import { resolveSmapiContext } from './auth-context.js';
import { getTokenStore, type SmapiStoredToken } from './token-store.js';

export type AuthFlowKind = 'devicelink' | 'applink';

export interface BeginAuthResult {
    kind: AuthFlowKind;
    /** Present for DeviceLink and AppLink-falls-back-to-DeviceLink flows. */
    regUrl?: string;
    /** The short code the user enters on the partner site. */
    linkCode?: string;
    /**
     * Sonos-side identifier that must be passed back to completeAuth.
     * For AppLink flows the partner may produce its own linkDeviceId;
     * if the service didn't return one, we fall back to the player's
     * deviceId on completeAuth.
     */
    linkDeviceId?: string;
    /** Set when the service hands off to a partner web flow. */
    appUrl?: string;
    /** Human-readable instructions, derived per flow. */
    instructions: string;
}

export interface CompleteAuthResult {
    serviceId: number;
    serviceName: string;
    householdId: string;
    storedAt: string;
}

export class SmapiAuthFlow {
    constructor(
        private readonly device: SonosDevice,
        private readonly service: MusicServiceDescriptor,
    ) {}

    private async newClient(): Promise<SMAPIClient> {
        const { deviceId, householdId } = await resolveSmapiContext(this.device);
        const store = getTokenStore();
        return new SMAPIClient(this.service, {
            deviceId,
            householdId,
            // No loginToken: we're in the auth flow itself.
            onTokenRefresh: pair => {
                // Best-effort persist; fire-and-forget since the call
                // chain is synchronous w.r.t. the retry.
                void store.refresh(this.service.id, householdId, {
                    token: pair.token,
                    key: pair.key,
                });
            },
        });
    }

    async begin(): Promise<BeginAuthResult> {
        const client = await this.newClient();
        const { householdId } = await resolveSmapiContext(this.device);

        if (this.service.authType === 'DeviceLink') {
            const result = await client.getDeviceLinkCode(householdId);
            if (!result) {
                throw new Error(
                    `getDeviceLinkCode failed for ${this.service.name}`
                );
            }
            return {
                kind: 'devicelink',
                regUrl: result.regUrl,
                linkCode: result.linkCode,
                linkDeviceId: result.linkDeviceId,
                instructions: this.devicelinkInstructions(result.regUrl, result.linkCode),
            };
        }

        if (this.service.authType === 'AppLink') {
            // Try the bare-host AppLink call first (matches sonoscli's
            // primary path). If the service ignores us — empty result —
            // fall back to the iPhone-shaped payload which is what
            // Sonos's own iOS app sends and most services accept.
            let result = await client.getAppLink({
                callbackPath: '',
                hardware: 'sonos-ts-mcp',
                householdId,
                osVersion: '1.0',
                sonosAppName: 'sonos-ts-mcp',
            });
            if (!result || (!result.appUrl && !result.regUrl)) {
                result = await client.getAppLink({
                    callbackPath: '',
                    hardware: 'iPhone15,2',
                    householdId,
                    osVersion: 'Version 17.5',
                    sonosAppName: 'ICRU_iPhone15,2',
                });
            }
            if (!result || (!result.appUrl && !result.regUrl)) {
                throw new Error(
                    `getAppLink returned no device-link or app URL for ${this.service.name}`
                );
            }

            if (result.regUrl && result.linkCode) {
                return {
                    kind: 'devicelink',
                    regUrl: result.regUrl,
                    linkCode: result.linkCode,
                    linkDeviceId: result.linkDeviceId,
                    instructions: this.devicelinkInstructions(result.regUrl, result.linkCode),
                };
            }

            return {
                kind: 'applink',
                appUrl: result.appUrl,
                instructions:
                    `Open this URL and complete the authentication flow. The partner ` +
                    `site will provide a code (sometimes redirected to a Sonos-style URL). ` +
                    `Paste that code back here as 'linkCode' to call sonos_smapi_auth_complete.\n\n` +
                    `URL: ${result.appUrl}`,
            };
        }

        throw new Error(
            `${this.service.name} uses authType=${this.service.authType} ` +
            `which does not support an MCP-side auth flow (Anonymous services ` +
            `don't need linking; UserId services need a separate username flow).`
        );
    }

    async complete(
        linkCode: string,
        linkDeviceId?: string,
    ): Promise<CompleteAuthResult> {
        if (!linkCode.trim()) {
            throw new Error('linkCode is required');
        }
        const { deviceId, householdId } = await resolveSmapiContext(this.device);
        const effectiveLinkDeviceId = (linkDeviceId ?? deviceId).trim();
        if (!effectiveLinkDeviceId) {
            throw new Error('linkDeviceId could not be resolved');
        }

        const client = await this.newClient();
        const pair = await client.getDeviceAuthToken(
            householdId,
            linkCode.trim(),
            effectiveLinkDeviceId,
        );
        if (!pair) {
            throw new Error(
                `getDeviceAuthToken returned no token pair for ${this.service.name}. ` +
                `Common causes: link code expired, partner flow not completed yet, ` +
                `or service refused the household.`
            );
        }

        const stored: SmapiStoredToken = {
            serviceId: this.service.id,
            serviceName: this.service.name,
            householdId,
            authToken: pair.authToken,
            privateKey: pair.privateKey,
            linkCode: linkCode.trim(),
            deviceId: deviceId,
            updatedAt: new Date().toISOString(),
        };
        await getTokenStore().save(stored);

        return {
            serviceId: stored.serviceId,
            serviceName: stored.serviceName,
            householdId: stored.householdId,
            storedAt: stored.updatedAt,
        };
    }

    private devicelinkInstructions(regUrl: string, linkCode: string): string {
        return (
            `Open this URL in a browser:\n  ${regUrl}\n\n` +
            `When prompted, enter this code:\n  ${linkCode}\n\n` +
            `After you approve the link on the partner site, call ` +
            `sonos_smapi_auth_complete with the same linkCode to exchange it ` +
            `for a long-lived token and save it. The link code expires in ` +
            `5–10 minutes depending on the service.`
        );
    }
}
