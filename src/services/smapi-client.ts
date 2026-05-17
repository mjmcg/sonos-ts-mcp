import type {
    MusicServiceDescriptor,
    MusicServiceItem,
    MusicServiceContainer,
    SMAPIResponse,
} from '../types/music-services.js';
import {
    buildSmapiEnvelope,
    buildSmapiSoapAction,
    SMAPI_USER_AGENT,
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
    /** R_TrialZPSerial from SystemProperties or the player's UDN. */
    deviceId: string;
    /**
     * Household ID from DeviceProperties.GetHouseholdID — required by
     * the documented envelope shape, which always carries it inside
     * <s:loginToken><s:householdId>. Used by both the pre-auth flow and
     * authenticated calls.
     */
    householdId: string;
    /** Stored token pair for authenticated services. */
    loginToken?: SmapiLoginToken;
    /**
     * Invoked when the service replies with a Client.TokenRefreshRequired
     * fault that embeds a fresh token pair. Used by callers to persist
     * the new credentials before the retry. Must be synchronous w.r.t.
     * the return — the retry happens immediately after.
     */
    onTokenRefresh?: (pair: SmapiLoginToken) => void;
    /** Optional timezone override; defaults to "+00:00". */
    timezone?: string;
    /** Override fetch (used by tests). */
    fetchImpl?: typeof fetch;
}

export interface ParsedSoapFault {
    faultCode: string;
    faultString: string;
}

/**
 * SOAP fault codes we treat as transient "wait, the link approval hasn't
 * propagated yet — try again" signals during getDeviceAuthToken. The user
 * just clicked approve on the partner site; Sonos's backend has a brief
 * window before the link becomes exchangeable.
 *
 * Casing is inconsistent across services — match case-insensitively on
 * the substring after the last dot.
 */
const TRANSIENT_AUTH_FAULTS = [
    'not_linked_retry',
    'notlinkedretry',
    'auth_retry',
    'authretry',
    'retry',
];

function isTransientAuthFault(fault: ParsedSoapFault | null): boolean {
    if (!fault) return false;
    const lower = fault.faultCode.toLowerCase();
    return TRANSIENT_AUTH_FAULTS.some(t => lower.includes(t));
}

export class SMAPIClient {
    private readonly serviceDescriptor: MusicServiceDescriptor;
    private readonly options: SmapiClientOptions;

    /**
     * Most recent SOAP fault from any call on this client instance.
     * Cleared at the start of every call. Lets auth-flow code surface
     * meaningful errors to users without changing every method's return
     * type to a Result<T, Fault>.
     */
    public lastFault: ParsedSoapFault | null = null;

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
     *
     * Retries with exponential backoff on transient "not linked yet"
     * faults — there's a race between the user clicking "approve" on
     * the partner site and Sonos's backend marking the household as
     * linked. AccuRadio commonly takes 1–3 seconds.
     *
     * On terminal failure, `lastFault` is set so the caller can surface
     * the actual SMAPI fault code/message to the user.
     */
    /**
     * Most recent raw response body, exposed for diagnostics when the
     * structured fault path fails. Used by callers (auth_complete in
     * particular) to surface "what did Sonos actually send back" when
     * neither a fault nor a parseable token came through.
     */
    public lastResponseBody: string | null = null;

    async getDeviceAuthToken(
        householdId: string,
        linkCode: string,
        linkDeviceId: string,
        options: { maxAttempts?: number; baseDelayMs?: number } = {},
    ): Promise<{ authToken: string; privateKey: string } | null> {
        const maxAttempts = options.maxAttempts ?? 6;
        const baseDelayMs = options.baseDelayMs ?? 800;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const body = await this.smapiCall(
                'getDeviceAuthToken',
                { householdId, linkCode, linkDeviceId },
                { allowUnauthed: true }
            );

            if (body) {
                const authToken = this.extractValue(body, 'authToken');
                const privateKey = this.extractValue(body, 'privateKey');
                if (authToken && privateKey) {
                    this.lastFault = null;
                    return { authToken, privateKey };
                }
                // 200 OK with no token AND no fault — Sonos sent back
                // *something* but it's neither the success shape nor a
                // SOAP fault. Treat as terminal; the caller will surface
                // lastResponseBody so the user can see what happened.
                return null;
            }

            // smapiCall returned null. If the fault is transient, back off
            // and try again; otherwise bail with lastFault set.
            if (!isTransientAuthFault(this.lastFault)) {
                return null;
            }
            const delay = baseDelayMs * Math.pow(1.5, attempt);
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        // Out of attempts — lastFault holds the most recent transient fault.
        return null;
    }

    // ─── low-level: build envelope, POST, parse SOAP fault ────────────────

    private async smapiCall(
        method: string,
        args: Record<string, string | number | boolean>,
        opts: { allowUnauthed?: boolean } = {}
    ): Promise<string | null> {
        this.lastFault = null;
        this.lastResponseBody = null;

        const endpoint = this.serviceDescriptor.secureUri || this.serviceDescriptor.uri;
        if (!endpoint) {
            console.error('SMAPI: service has no secureUri/uri');
            return null;
        }

        const envelope = buildSmapiEnvelope({
            method,
            args: Object.fromEntries(
                Object.entries(args).map(([k, v]) => [k, String(v)])
            ),
            credentials: {
                deviceId: this.options.deviceId,
                householdId: this.options.householdId,
                // During the pre-auth flow we deliberately emit an empty
                // loginToken (the envelope builder handles this when
                // loginToken is undefined). Otherwise extract token+key
                // from the stored pair — householdId is set above.
                loginToken: opts.allowUnauthed || !this.options.loginToken
                    ? undefined
                    : {
                        token: this.options.loginToken.token,
                        key: this.options.loginToken.key,
                    },
                timezone: this.options.timezone,
            },
        });

        const response = await this.postEnvelope(endpoint, method, envelope);
        if (!response) return null;

        // Expose raw body for diagnostics regardless of success/failure.
        this.lastResponseBody = response.body;

        // Check for SOAP fault FIRST — some services return 200 OK with a
        // Fault embedded. Previously this path silently returned an
        // unparseable body and the caller saw "empty result".
        const fault = this.parseSoapFault(response.body);
        if (fault) {
            this.lastFault = fault;
        } else if (response.ok) {
            return response.body;
        }

        if (!fault) {
            // Non-OK status with no parseable fault. Log raw status and bail.
            console.error(`SMAPI ${method} HTTP ${response.status}`);
            return null;
        }

        if (fault.faultCode.includes('TokenRefreshRequired')) {
            const refreshed = this.extractRefreshedToken(response.body);
            if (refreshed && this.options.onTokenRefresh) {
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
                        householdId: this.options.householdId,
                        loginToken: {
                            token: refreshed.authToken,
                            key: refreshed.privateKey,
                        },
                        timezone: this.options.timezone,
                    },
                });
                const retry = await this.postEnvelope(endpoint, method, retryEnvelope);
                if (retry?.ok) {
                    this.lastFault = null;
                    return retry.body;
                }
                if (retry) {
                    const retryFault = this.parseSoapFault(retry.body);
                    if (retryFault) this.lastFault = retryFault;
                    console.error(
                        `SMAPI ${method} after refresh: ${retryFault?.faultCode ?? 'HTTP error'}: ${retryFault?.faultString ?? ''}`
                    );
                }
                return null;
            }
        }

        // Terminal fault — log for container debugging; caller can read
        // `lastFault` for the structured details.
        console.error(`SMAPI ${method} fault: ${fault.faultCode}: ${fault.faultString}`);
        return null;
    }

    private async postEnvelope(
        endpoint: string,
        method: string,
        envelope: string
    ): Promise<{ ok: boolean; status: number; body: string } | null> {
        const debug = process.env.SMAPI_DEBUG === '1' || process.env.SMAPI_DEBUG === 'true';
        if (debug) {
            console.error(`[SMAPI DEBUG] POST ${endpoint}`);
            console.error(`[SMAPI DEBUG] method=${method} service=${this.serviceDescriptor.name} (id=${this.serviceDescriptor.id})`);
            console.error(`[SMAPI DEBUG] request envelope:\n${redactEnvelope(envelope)}`);
        }
        try {
            const f = this.options.fetchImpl ?? fetch;
            const resp = await f(endpoint, {
                method: 'POST',
                headers: {
                    // Headers exactly as documented at
                    // sonos.svrooij.io/music-services.html. Apple Music
                    // (and likely other strict services) gate on a
                    // Sonos-shaped User-Agent — without it we get the
                    // empty-result / music:// dead-end paths.
                    'Content-Type': 'text/xml; charset=utf8',
                    'SOAPACTION': buildSmapiSoapAction(method),
                    'Accept-Language': 'en-US',
                    'Accept-Encoding': 'gzip, deflate',
                    'User-Agent': SMAPI_USER_AGENT,
                },
                body: envelope,
            });
            const body = await resp.text();
            if (debug) {
                console.error(`[SMAPI DEBUG] response status=${resp.status} ok=${resp.ok}`);
                console.error(`[SMAPI DEBUG] response body:\n${redactEnvelope(body)}`);
            }
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

/**
 * Mask credential values inside SOAP envelopes for SMAPI_DEBUG output.
 *
 * Auth tokens, private keys, and refreshed credentials all show up in
 * either the request envelope (when we have a loginToken) or the
 * response envelope (when getDeviceAuthToken or a TokenRefreshRequired
 * fault carries fresh credentials). Redact them in debug logs so users
 * can paste log snippets without exposing the linked account.
 *
 * Link codes ARE shown — they're short-lived (5–10 minutes) and the
 * whole point of debugging is to verify Sonos is seeing them correctly.
 */
function redactEnvelope(xml: string): string {
    const REDACT_TAGS = ['token', 'authToken', 'privateKey', 'key', 'sessionId'];
    let result = xml;
    for (const tag of REDACT_TAGS) {
        // Replace inner text; preserve tag + attributes for structural clarity.
        const pattern = new RegExp(
            `(<(?:\\w+:)?${tag}[^>]*>)([^<]+)(<\\/(?:\\w+:)?${tag}>)`,
            'g',
        );
        result = result.replace(pattern, (_match, open, inner: string, close) => {
            const masked = inner.length > 8
                ? `<redacted:${inner.length}>`
                : '<redacted>';
            return `${open}${masked}${close}`;
        });
    }
    return result;
}

/**
 * Build a short, log-safe snippet of a SOAP response body for error
 * messages. Trims to ~600 chars and runs the same credential redaction
 * as the debug logger so callers can paste the error verbatim.
 */
export function summarizeResponseBody(body: string | null | undefined): string {
    if (!body) return '(empty response)';
    const redacted = redactEnvelope(body).trim();
    const limit = 600;
    if (redacted.length <= limit) return redacted;
    return redacted.slice(0, limit) + `… (truncated, full length ${redacted.length})`;
}
