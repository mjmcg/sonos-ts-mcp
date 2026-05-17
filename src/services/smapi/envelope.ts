/**
 * Construct SMAPI SOAP envelopes.
 *
 * Sonos's SMAPI is plain SOAP 1.1 over HTTPS. Every call MUST include a
 * `<credentials>` element — but the previous implementation put it inside
 * the SOAP Body's method element, which is wrong. The spec requires it as
 * a SOAP Header, and most service implementations either return empty
 * results or 500 if it's missing or misplaced.
 *
 * Two-tier credentials shape:
 *
 *   Anonymous services (TuneIn, SomaFM, CBC Radio & Music, etc.):
 *     <credentials>
 *       <deviceId>...</deviceId>
 *       <deviceProvider>Sonos</deviceProvider>
 *     </credentials>
 *
 *   Authenticated services (Apple Music, Spotify, AccuRadio, …),
 *   before a token is stored — used during the auth flow itself:
 *     <credentials>
 *       <deviceId>...</deviceId>
 *       <deviceProvider>Sonos</deviceProvider>
 *       <context></context>
 *     </credentials>
 *
 *   Authenticated services with a stored token:
 *     <credentials>
 *       <deviceId>...</deviceId>
 *       <deviceProvider>Sonos</deviceProvider>
 *       <context></context>
 *       <loginToken>
 *         <token>...</token>
 *         <key>...</key>
 *         <householdId>...</householdId>
 *       </loginToken>
 *     </credentials>
 *
 * sessionId is preserved as an optional sibling for services that prefer
 * it over loginToken (older UserID-based flows). Both can coexist; SMAPI
 * picks the one matching its declared auth type.
 */

export const SMAPI_NAMESPACE = 'http://www.sonos.com/Services/1.1';
export const SMAPI_SOAP_ACTION_PREFIX = 'http://www.sonos.com/Services/1.1#';

export interface SmapiLoginToken {
    token: string;
    key: string;
    householdId: string;
}

export interface SmapiCredentialsOptions {
    deviceId: string;
    deviceProvider?: string;
    /** Set true for DeviceLink/AppLink services — adds <context></context>. */
    includeContext?: boolean;
    /** Provide once an auth flow has completed and tokens are stored. */
    loginToken?: SmapiLoginToken;
    /** Legacy/UserID-style session id. */
    sessionId?: string;
}

export interface SmapiEnvelopeOptions {
    method: string;
    /**
     * Tag-name → value map. Values are XML-text-escaped. Order is
     * insertion order. SMAPI is tolerant of element order within a
     * method, so callers can use object literals.
     */
    args: Record<string, string | number | boolean>;
    credentials: SmapiCredentialsOptions;
}

function escapeXmlText(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeXmlAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function buildCredentialsXml(opts: SmapiCredentialsOptions): string {
    const parts: string[] = [];
    parts.push(`<credentials xmlns="${escapeXmlAttr(SMAPI_NAMESPACE)}">`);
    parts.push(`<deviceId>${escapeXmlText(opts.deviceId)}</deviceId>`);
    parts.push(`<deviceProvider>${escapeXmlText(opts.deviceProvider ?? 'Sonos')}</deviceProvider>`);

    if (opts.includeContext || opts.loginToken) {
        parts.push('<context></context>');
    }
    if (opts.loginToken) {
        parts.push('<loginToken>');
        parts.push(`<token>${escapeXmlText(opts.loginToken.token)}</token>`);
        parts.push(`<key>${escapeXmlText(opts.loginToken.key)}</key>`);
        parts.push(`<householdId>${escapeXmlText(opts.loginToken.householdId)}</householdId>`);
        parts.push('</loginToken>');
    }
    if (opts.sessionId) {
        parts.push(`<sessionId>${escapeXmlText(opts.sessionId)}</sessionId>`);
    }
    parts.push('</credentials>');
    return parts.join('');
}

export function buildSmapiEnvelope(opts: SmapiEnvelopeOptions): string {
    const { method, args, credentials } = opts;
    const credsXml = buildCredentialsXml(credentials);

    const argTags: string[] = [];
    for (const [key, rawValue] of Object.entries(args)) {
        const value = typeof rawValue === 'boolean'
            ? (rawValue ? '1' : '0')
            : String(rawValue);
        argTags.push(`<${key}>${escapeXmlText(value)}</${key}>`);
    }

    return [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ',
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
        '<s:Header>',
        credsXml,
        '</s:Header>',
        '<s:Body>',
        `<${method} xmlns="${escapeXmlAttr(SMAPI_NAMESPACE)}">`,
        argTags.join(''),
        `</${method}>`,
        '</s:Body>',
        '</s:Envelope>',
    ].join('');
}

export function buildSmapiSoapAction(method: string): string {
    // SOAPACTION must be a quoted URL per the spec. Some services 400
    // without the literal quotes.
    return `"${SMAPI_SOAP_ACTION_PREFIX}${method}"`;
}
