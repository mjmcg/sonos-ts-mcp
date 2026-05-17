import type {
    MusicServiceDescriptor,
    MusicServiceItem,
    MusicServiceContainer,
    SMAPIResponse,
} from '../types/music-services.js';
import {
    buildSmapiEnvelope,
    buildSmapiSoapAction,
    type SmapiLoginToken,
} from './smapi/envelope.js';

/**
 * SMAPI (Sonos Music API) client for third-party music services.
 *
 * Auth context is passed to the constructor and used to build the
 * `<credentials>` SOAP Header on every request. For DeviceLink and
 * AppLink services, supply a stored token pair via `loginToken`; SMAPI
 * will reject auth-required browse/search calls otherwise.
 *
 * Token-refresh handling (Client.TokenRefreshRequired SOAP fault) is
 * delegated to the caller via the `onTokenRefresh` callback — when the
 * service returns a fresh token pair embedded in the fault, the callback
 * is invoked with the new pair and the call is retried once.
 */
export interface SmapiClientOptions {
    /** Required for any authenticated call. */
    deviceId: string;
    /** Optional; defaults to 'Sonos'. */
    deviceProvider?: string;
    /** Required only for the auth flow itself. */
    householdId?: string;
    /** Stored token pair for authenticated services. */
    loginToken?: SmapiLoginToken;
    /** Legacy session id (UserID-style services). */
    sessionId?: string;
    /**
     * Invoked when the service replies with a Client.TokenRefreshRequired
     * fault that embeds a fresh token pair. Used by callers to persist
     * the new credentials before the retry. Must be synchronous w.r.t.
     * the return — the retry happens immediately after.
     */
    onTokenRefresh?: (pair: SmapiLoginToken) => void;
    /** Override fetch (used by tests). */
    fetchImpl?: typeof fetch;
}

interface ParsedSoapFault {
    faultCode: string;
    faultString: string;
}

export class SMAPIClient {
    private readonly serviceDescriptor: MusicServiceDescriptor;
    private readonly options: SmapiClientOptions;

    constructor(serviceDescriptor: MusicServiceDescriptor, options: SmapiClientOptions) {
        this.serviceDescriptor = serviceDescriptor;
        this.options = options;
    }

    // ─── public API ────────────────────────────────────────────────────────

    async getMetadata(
        id: string,
        index = 0,
        count = 100
    ): Promise<SMAPIResponse> {
        const body = await this.smapiCall('getMetadata', {
            id, index, count,
        });
        if (!body) return { items: [], total: 0, index: 0, count: 0 };
        return this.parseMetadataResponse(body);
    }

    async search(
        term: string,
        index = 0,
        count = 100,
        searchId = 'search:all'
    ): Promise<SMAPIResponse> {
        const body = await this.smapiCall('search', {
            id: searchId,
            term, index, count,
        });
        if (!body) return { items: [], total: 0, index: 0, count: 0 };
        return this.parseMetadataResponse(body);
    }

    async getExtendedMetadata(id: string): Promise<MusicServiceItem | null> {
        const body = await this.smapiCall('getExtendedMetadata', { id });
        if (!body) return null;
        return this.parseExtendedMetadataResponse(body);
    }

    async getMediaURI(id: string): Promise<string | null> {
        const body = await this.smapiCall('getMediaURI', { id });
        if (!body) return null;
        return this.parseMediaURIResponse(body);
    }

    // ─── auth flow primitives (used by Commit 2) ──────────────────────────

    /**
     * Begin a DeviceLink flow. Service must have authType=DeviceLink.
     * Returns the registration URL and link code that the user must
     * enter on the partner site to complete linking.
     */
    async getDeviceLinkCode(householdId: string): Promise<{
        regUrl: string;
        linkCode: string;
        linkDeviceId: string;
    } | null> {
        const body = await this.smapiCall(
            'getDeviceLinkCode',
            { householdId },
            { allowUnauthed: true }
        );
        if (!body) return null;
        return {
            regUrl: this.extractValue(body, 'regUrl') ?? '',
            linkCode: this.extractValue(body, 'linkCode') ?? '',
            linkDeviceId: this.extractValue(body, 'linkDeviceId') ?? '',
        };
    }

    /**
     * Begin an AppLink flow. Service must have authType=AppLink. The
     * `args` map carries the per-service launch context (hardware,
     * sonosAppName, etc.). The response varies: the service may return a
     * deviceLink-style code OR an app-launch URL (AppURL) the user must
     * open. Callers should surface both.
     */
    async getAppLink(args: Record<string, string>): Promise<{
        regUrl: string;
        linkCode: string;
        linkDeviceId: string;
        appUrl: string;
        appUrlStringId: string;
    } | null> {
        const body = await this.smapiCall(
            'getAppLink',
            args,
            { allowUnauthed: true }
        );
        if (!body) return null;
        return {
            regUrl: this.extractValue(body, 'regUrl') ?? '',
            linkCode: this.extractValue(body, 'linkCode') ?? '',
            linkDeviceId: this.extractValue(body, 'linkDeviceId') ?? '',
            appUrl: this.extractValue(body, 'appUrl') ?? '',
            appUrlStringId: this.extractValue(body, 'appUrlStringId') ?? '',
        };
    }

    /**
     * Exchange a completed link code for a token pair. Caller must
     * persist the returned pair (it is not stored here — keeps the
     * client free of filesystem dependencies).
     */
    async getDeviceAuthToken(
        householdId: string,
        linkCode: string,
        linkDeviceId: string
    ): Promise<{ authToken: string; privateKey: string } | null> {
        const body = await this.smapiCall(
            'getDeviceAuthToken',
            { householdId, linkCode, linkDeviceId },
            { allowUnauthed: true }
        );
        if (!body) return null;
        const authToken = this.extractValue(body, 'authToken');
        const privateKey = this.extractValue(body, 'privateKey');
        if (!authToken || !privateKey) return null;
        return { authToken, privateKey };
    }

    // ─── low-level: build envelope, POST, parse SOAP fault ────────────────

    private async smapiCall(
        method: string,
        args: Record<string, string | number | boolean>,
        opts: { allowUnauthed?: boolean } = {}
    ): Promise<string | null> {
        const endpoint = this.serviceDescriptor.secureUri || this.serviceDescriptor.uri;
        if (!endpoint) {
            console.error('SMAPI: service has no secureUri/uri');
            return null;
        }

        const isAuthenticatedService =
            this.serviceDescriptor.authType === 'DeviceLink' ||
            this.serviceDescriptor.authType === 'AppLink';

        const envelope = buildSmapiEnvelope({
            method,
            args: Object.fromEntries(
                Object.entries(args).map(([k, v]) => [k, String(v)])
            ),
            credentials: {
                deviceId: this.options.deviceId,
                deviceProvider: this.options.deviceProvider,
                includeContext: isAuthenticatedService,
                loginToken: opts.allowUnauthed ? undefined : this.options.loginToken,
                sessionId: this.options.sessionId,
            },
        });

        const response = await this.postEnvelope(endpoint, method, envelope);
        if (!response) return null;

        if (response.ok) {
            return response.body;
        }

        // SMAPI returns SOAP faults with HTTP 500. Inspect for token-
        // refresh and retry once with the new credentials if available.
        const fault = this.parseSoapFault(response.body);
        if (fault?.faultCode.includes('TokenRefreshRequired')) {
            const refreshed = this.extractRefreshedToken(response.body);
            if (refreshed && this.options.householdId && this.options.onTokenRefresh) {
                this.options.onTokenRefresh({
                    token: refreshed.authToken,
                    key: refreshed.privateKey,
                    householdId: this.options.householdId,
                });
                // Rebuild the envelope with the new token and retry once.
                const retryEnvelope = buildSmapiEnvelope({
                    method,
                    args: Object.fromEntries(
                        Object.entries(args).map(([k, v]) => [k, String(v)])
                    ),
                    credentials: {
                        deviceId: this.options.deviceId,
                        deviceProvider: this.options.deviceProvider,
                        includeContext: isAuthenticatedService,
                        loginToken: {
                            token: refreshed.authToken,
                            key: refreshed.privateKey,
                            householdId: this.options.householdId,
                        },
                        sessionId: this.options.sessionId,
                    },
                });
                const retry = await this.postEnvelope(endpoint, method, retryEnvelope);
                if (retry?.ok) return retry.body;
                if (retry) {
                    const retryFault = this.parseSoapFault(retry.body);
                    console.error(
                        `SMAPI ${method} after refresh: ${retryFault?.faultCode ?? 'HTTP error'}: ${retryFault?.faultString ?? ''}`
                    );
                }
                return null;
            }
        }

        if (fault) {
            console.error(`SMAPI ${method} fault: ${fault.faultCode}: ${fault.faultString}`);
        } else {
            console.error(`SMAPI ${method} HTTP ${response.status}`);
        }
        return null;
    }

    private async postEnvelope(
        endpoint: string,
        method: string,
        envelope: string
    ): Promise<{ ok: boolean; status: number; body: string } | null> {
        try {
            const f = this.options.fetchImpl ?? fetch;
            const resp = await f(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/xml; charset="utf-8"',
                    'SOAPACTION': buildSmapiSoapAction(method),
                },
                body: envelope,
            });
            const body = await resp.text();
            return { ok: resp.ok, status: resp.status, body };
        } catch (error) {
            console.error('SMAPI request error:', error);
            return null;
        }
    }

    // ─── response parsing ─────────────────────────────────────────────────

    private parseMetadataResponse(xml: string): SMAPIResponse {
        const items: (MusicServiceItem | MusicServiceContainer)[] = [];

        const total = parseInt(this.extractValue(xml, 'total') ?? '0');
        const index = parseInt(this.extractValue(xml, 'index') ?? '0');
        const count = parseInt(this.extractValue(xml, 'count') ?? '0');

        for (const match of xml.matchAll(/<(?:\w+:)?mediaCollection>([\s\S]*?)<\/(?:\w+:)?mediaCollection>/g)) {
            const item = this.parseMediaCollection(match[1] ?? '');
            if (item) items.push(item);
        }
        for (const match of xml.matchAll(/<(?:\w+:)?mediaMetadata>([\s\S]*?)<\/(?:\w+:)?mediaMetadata>/g)) {
            const item = this.parseMediaMetadata(match[1] ?? '');
            if (item) items.push(item);
        }

        return { items, total, index, count };
    }

    private parseMediaCollection(xml: string): MusicServiceContainer | null {
        const id = this.extractValue(xml, 'id');
        const title = this.extractValue(xml, 'title');
        if (!id || !title) return null;
        const itemType = this.extractValue(xml, 'itemType');
        return {
            id,
            title,
            canEnumerate: this.extractValue(xml, 'canEnumerate') !== 'false',
            canPlay: this.extractValue(xml, 'canPlay') === 'true',
            itemType: (itemType as MusicServiceContainer['itemType']) || 'container',
            albumArtUri: this.extractValue(xml, 'albumArtURI') || undefined,
            artist: this.extractValue(xml, 'artist') || undefined,
            childCount: this.extractValue(xml, 'childCount')
                ? parseInt(this.extractValue(xml, 'childCount')!)
                : undefined,
        };
    }

    private parseMediaMetadata(xml: string): MusicServiceItem | null {
        const id = this.extractValue(xml, 'id');
        const title = this.extractValue(xml, 'title');
        if (!id || !title) return null;
        const itemType = this.extractValue(xml, 'itemType');
        const duration = this.extractValue(xml, 'duration');
        return {
            id,
            title,
            mimeType: this.extractValue(xml, 'mimeType') || 'audio/mpeg',
            itemType: (itemType as MusicServiceItem['itemType']) || 'track',
            canPlay: this.extractValue(xml, 'canPlay') !== 'false',
            artist: this.extractValue(xml, 'artist') || undefined,
            artistId: this.extractValue(xml, 'artistId') || undefined,
            album: this.extractValue(xml, 'album') || undefined,
            albumId: this.extractValue(xml, 'albumId') || undefined,
            albumArtUri: this.extractValue(xml, 'albumArtURI') || undefined,
            duration: duration ? parseInt(duration) : undefined,
            uri: this.extractValue(xml, 'uri') || undefined,
            trackNumber: this.extractValue(xml, 'trackNumber')
                ? parseInt(this.extractValue(xml, 'trackNumber')!)
                : undefined,
        };
    }

    private parseExtendedMetadataResponse(xml: string): MusicServiceItem | null {
        const metadataMatch = xml.match(/<(?:\w+:)?mediaMetadata>([\s\S]*?)<\/(?:\w+:)?mediaMetadata>/);
        if (!metadataMatch) return null;
        return this.parseMediaMetadata(metadataMatch[1] ?? '');
    }

    private parseMediaURIResponse(xml: string): string | null {
        const uriMatch = xml.match(/<(?:\w+:)?getMediaURIResult>([\s\S]*?)<\/(?:\w+:)?getMediaURIResult>/);
        if (!uriMatch) return null;
        const content = uriMatch[1]?.trim() ?? '';
        if (content && !content.includes('<')) {
            return content;
        }
        const nestedUri = this.extractValue(content, 'uri');
        return nestedUri || null;
    }

    private parseSoapFault(xml: string): ParsedSoapFault | null {
        const faultMatch = xml.match(/<(?:\w+:)?Fault[\s\S]*?<\/(?:\w+:)?Fault>/);
        if (!faultMatch) return null;
        const faultCode = this.extractValue(faultMatch[0], 'faultcode')
            ?? this.extractValue(faultMatch[0], 'faultCode')
            ?? '';
        const faultString = this.extractValue(faultMatch[0], 'faultstring')
            ?? this.extractValue(faultMatch[0], 'faultString')
            ?? '';
        return { faultCode, faultString };
    }

    /**
     * SMAPI's TokenRefreshRequired faults embed the fresh `<authToken>`
     * and `<privateKey>` inside the SOAP detail element. Extract them so
     * callers can persist and retry.
     */
    private extractRefreshedToken(xml: string): { authToken: string; privateKey: string } | null {
        const authToken = this.extractValue(xml, 'authToken');
        const privateKey = this.extractValue(xml, 'privateKey');
        if (!authToken || !privateKey) return null;
        return { authToken, privateKey };
    }

    private extractValue(xml: string, tagName: string): string | null {
        const match = xml.match(
            new RegExp(`<(?:\\w+:)?${tagName}[^>]*>([^<]*)<\\/(?:\\w+:)?${tagName}>`)
        );
        return match ? (match[1]?.trim() ?? null) : null;
    }
}
