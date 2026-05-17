/**
 * Build SMAPI SOAP envelopes per the authoritative format documented at
 * https://sonos.svrooij.io/music-services.html (svrooij's reverse-
 * engineering of what Sonos's own iOS app sends).
 *
 * Two prior implementations had structural drift that probably caused
 * Apple Music, AccuRadio, and other services to silently reject our
 * requests:
 *
 *   1. sonoscli (Go): used `<credentials xmlns="...">` with a default
 *      namespace and emitted `<context></context>` *inside* credentials.
 *      Missing the <s:timezone> child. Included an extraneous
 *      <deviceProvider>Sonos</deviceProvider>. Omitted <loginToken>
 *      entirely during the pre-auth flow.
 *
 *   2. Our v1 (before this rewrite): same shape as sonoscli, with the
 *      same drift.
 *
 * The documented format that Sonos's iOS app sends, and that all the
 * services consistently accept:
 *
 *   <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
 *                  xmlns:s="http://www.sonos.com/Services/1.1">
 *     <soap:Header>
 *       <s:context>
 *         <s:timezone>+00:00</s:timezone>
 *       </s:context>
 *       <s:credentials>
 *         <s:deviceId>{DEVICE_ID}</s:deviceId>
 *         <s:loginToken>
 *           <s:token>{TOKEN_OR_EMPTY}</s:token>
 *           <s:key>{KEY_OR_EMPTY}</s:key>
 *           <s:householdId>{HOUSEHOLD_ID}</s:householdId>
 *         </s:loginToken>
 *       </s:credentials>
 *     </soap:Header>
 *     <soap:Body>
 *       <s:{ACTION_NAME}>
 *         <s:{arg1}>{value1}</s:{arg1}>
 *         ...
 *       </s:{ACTION_NAME}>
 *     </soap:Body>
 *   </soap:Envelope>
 *
 * For the pre-auth flow (getDeviceLinkCode, getAppLink,
 * getDeviceAuthToken), <s:token> and <s:key> are emitted as empty
 * elements — that's how Sonos signals "I'm in the linking flow and
 * don't have credentials yet". <s:householdId> is always populated.
 *
 * No <deviceProvider> — svrooij's docs are explicit about the shape
 * and don't include it. sonoscli's variant works for some services
 * (presumably the more permissive XML parsers) but not the strict
 * ones; matching the documented format is the safer default.
 */

export const SMAPI_NAMESPACE = 'http://www.sonos.com/Services/1.1';
export const SMAPI_SOAP_ACTION_PREFIX = 'http://www.sonos.com/Services/1.1#';

/**
 * Mimic Sonos's own iOS app fingerprint. Some services (notably Apple
 * Music) gate on a Sonos-like User-Agent — without it we silently get
 * empty responses or the music:// dead-end deep link.
 */
export const SMAPI_USER_AGENT =
    'Linux UPnP/1.0 Sonos/29.3-87071 (ICRU_iPhone7,1); iOS/Version 8.2 (Build 12D508)';

export interface SmapiLoginToken {
    token: string;
    key: string;
    householdId: string;
}

export interface SmapiCredentialsOptions {
    deviceId: string;
    householdId: string;
    /**
     * Populated once an auth flow has completed. Omit (or leave undefined)
     * for the pre-auth flow itself — the envelope will emit
     * <s:token></s:token><s:key></s:key> with the householdId.
     */
    loginToken?: { token: string; key: string };
    /** Optional override; defaults to "+00:00". */
    timezone?: string;
}

export interface SmapiEnvelopeOptions {
    method: string;
    /**
     * Argument tag-name → value map. Values are XML-text-escaped, then
     * wrapped in `<s:{tag}>{value}</s:{tag}>` children of the method
     * element.
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

/**
 * Build the inner <s:credentials> + <s:context> SOAP header pair
 * exactly as documented. Returned without the outer <soap:Header>
 * wrapper so it can be unit-tested in isolation.
 */
export function buildSmapiHeaderXml(opts: SmapiCredentialsOptions): string {
    const timezone = opts.timezone ?? '+00:00';
    const token = opts.loginToken?.token ?? '';
    const key = opts.loginToken?.key ?? '';

    return [
        `<s:context>`,
        `<s:timezone>${escapeXmlText(timezone)}</s:timezone>`,
        `</s:context>`,
        `<s:credentials>`,
        `<s:deviceId>${escapeXmlText(opts.deviceId)}</s:deviceId>`,
        `<s:loginToken>`,
        `<s:token>${escapeXmlText(token)}</s:token>`,
        `<s:key>${escapeXmlText(key)}</s:key>`,
        `<s:householdId>${escapeXmlText(opts.householdId)}</s:householdId>`,
        `</s:loginToken>`,
        `</s:credentials>`,
    ].join('');
}

export function buildSmapiEnvelope(opts: SmapiEnvelopeOptions): string {
    const { method, args, credentials } = opts;
    const header = buildSmapiHeaderXml(credentials);

    const argTags: string[] = [];
    for (const [key, rawValue] of Object.entries(args)) {
        const value = typeof rawValue === 'boolean'
            ? (rawValue ? '1' : '0')
            : String(rawValue);
        argTags.push(`<s:${key}>${escapeXmlText(value)}</s:${key}>`);
    }

    return [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ',
        `xmlns:s="${SMAPI_NAMESPACE}">`,
        '<soap:Header>',
        header,
        '</soap:Header>',
        '<soap:Body>',
        `<s:${method}>`,
        argTags.join(''),
        `</s:${method}>`,
        '</soap:Body>',
        '</soap:Envelope>',
    ].join('');
}

export function buildSmapiSoapAction(method: string): string {
    // SOAPACTION must be a quoted URL per the spec. Some services 400
    // without the literal quotes.
    return `"${SMAPI_SOAP_ACTION_PREFIX}${method}"`;
}
