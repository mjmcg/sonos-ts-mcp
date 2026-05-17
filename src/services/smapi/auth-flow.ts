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
                throw this.faultError(client, `getDeviceLinkCode failed for ${this.service.name}`);
            }
            if (!result.regUrl || !result.linkCode) {
                throw new Error(
                    `getDeviceLinkCode for ${this.service.name} returned an incomplete response ` +
                    `(regUrl=${JSON.stringify(result.regUrl)}, linkCode=${JSON.stringify(result.linkCode)}).`
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
            // Many services (notably Apple Music) only return a usable
            // <deviceLink> code if you claim to be an iPhone. The bare-
            // host shape just gets you an `music://` deep link, which is
            // unusable from a container. Try both and prefer any result
            // that gave us a deviceLink the user can actually type.
            const attempts: Array<Record<string, string>> = [
                {
                    callbackPath: '',
                    hardware: 'iPhone15,2',
                    householdId,
                    osVersion: 'Version 17.5',
                    sonosAppName: 'ICRU_iPhone15,2',
                },
                {
                    callbackPath: '',
                    hardware: 'sonos-ts-mcp',
                    householdId,
                    osVersion: '1.0',
                    sonosAppName: 'sonos-ts-mcp',
                },
            ];

            type AppLinkResult = NonNullable<Awaited<ReturnType<typeof client.getAppLink>>>;
            const results: AppLinkResult[] = [];
            for (const args of attempts) {
                const result = await client.getAppLink(args);
                if (result) results.push(result);
                // First result with a usable deviceLink wins — no point
                // probing further.
                if (result?.regUrl && result?.linkCode) break;
            }

            const withDeviceLink = results.find(r => r.regUrl && r.linkCode);
            if (withDeviceLink) {
                return {
                    kind: 'devicelink',
                    regUrl: withDeviceLink.regUrl,
                    linkCode: withDeviceLink.linkCode,
                    linkDeviceId: withDeviceLink.linkDeviceId,
                    instructions: this.devicelinkInstructions(
                        withDeviceLink.regUrl,
                        withDeviceLink.linkCode,
                    ),
                };
            }

            const withAppUrl = results.find(r => r.appUrl);
            if (withAppUrl) {
                return {
                    kind: 'applink',
                    appUrl: withAppUrl.appUrl,
                    instructions: this.applinkInstructions(withAppUrl.appUrl, this.service.name),
                };
            }

            throw this.faultError(
                client,
                `getAppLink returned no device-link or app URL for ${this.service.name}`
            );
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
            const fault = client.lastFault;
            const baseMessage =
                `getDeviceAuthToken returned no token pair for ${this.service.name}.`;
            if (fault) {
                throw new Error(
                    `${baseMessage} SMAPI fault: ${fault.faultCode}: ${fault.faultString || '(no detail)'}. ` +
                    `Common causes: link code expired (re-run sonos_smapi_auth_begin), ` +
                    `partner flow not yet propagated (retry in a few seconds), or the ` +
                    `wrong linkDeviceId.`
                );
            }
            throw new Error(
                `${baseMessage} No SMAPI fault returned — common causes: link code ` +
                `expired or service silently rejected. Re-run sonos_smapi_auth_begin ` +
                `to get a fresh code.`
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
            `5–10 minutes depending on the service. The complete call retries ` +
            `automatically on transient 'not linked yet' faults — if the ` +
            `partner site shows success but the exchange still fails after ` +
            `~10 seconds, the link code is probably already expired.`
        );
    }

    private applinkInstructions(appUrl: string, serviceName: string): string {
        return (
            `${serviceName} returned only an app deep-link URL, not a typed ` +
            `code. This flow is hard to complete from a containerised MCP ` +
            `server because the partner-side redirect targets the Sonos app ` +
            `(sonos://x-callback-url/...), which the MCP can't intercept.\n\n` +
            `URL: ${appUrl}\n\n` +
            `Options:\n` +
            `  1. Link the service via a different tool that can register ` +
            `as a sonos:// URL handler (e.g. sonoscli on a laptop), then ` +
            `copy the token blob to MCP_DATA_DIR/smapi-tokens.json.\n` +
            `  2. Open the URL in a browser, open DevTools, and capture the ` +
            `partner redirect — the link code is in the URL fragment. Paste ` +
            `that code to sonos_smapi_auth_complete.\n` +
            `  3. Use sonos_get_favorites + sonos_play_favorite if you mainly ` +
            `want to play stations / playlists you've already favorited in ` +
            `the Sonos app — that path works without per-service linking.`
        );
    }

    /**
     * Wrap an SMAPIClient call failure in an Error that surfaces the SOAP
     * fault details (if any) instead of forcing the caller to inspect
     * client.lastFault separately.
     */
    private faultError(
        client: SMAPIClient,
        baseMessage: string,
    ): Error {
        const fault = client.lastFault;
        if (!fault) return new Error(baseMessage);
        return new Error(
            `${baseMessage}. SMAPI fault: ${fault.faultCode}: ${fault.faultString || '(no detail)'}`
        );
    }
}
