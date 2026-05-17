/**
 * Build SMAPI SOAP envelopes per the authoritative Sonos OEM docs:
 *   https://docs.sonos.com/docs/getapplink
 *   https://docs.sonos.com/docs/getdeviceauthtoken
 *   https://docs.sonos.com/docs/soap-requests
 *
 * The OEM-documented credentials header is intentionally minimal:
 *
 *   <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
 *                  xmlns:s="http://www.sonos.com/Services/1.1">
 *     <soap:Header>
 *       <s:credentials>
 *         <s:deviceId>{DEVICE_ID}</s:deviceId>
 *         <s:deviceProvider>Sonos</s:deviceProvider>
 *         <!-- loginToken only when we have one: -->
 *         <s:loginToken>
 *           <s:token>...</s:token>
 *           <s:key>...</s:key>
 *           <s:householdId>...</s:householdId>
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
 * Notes vs the previous (svrooij-style) shape we shipped:
 *
 *   - <s:deviceProvider>Sonos</s:deviceProvider> is REQUIRED per OEM and
 *     is what the partner-side auth backends key off. We previously
 *     stripped it on advice from svrooij's reverse-engineered docs; that
 *     turned out to be the wrong call — the OEM spec is authoritative.
 *
 *   - <s:loginToken> is OPTIONAL. The auth-bootstrap methods
 *     (getAppLink, getDeviceLinkCode, getDeviceAuthToken) take no
 *     credentials beyond deviceId/deviceProvider; emitting an empty
 *     loginToken there was non-spec. Once a service is linked, the
 *     stored token/key/householdId go inside loginToken on every
 *     subsequent request.
 *
 *   - No <s:context>/<s:timezone> header. Not present in the OEM spec.
 *
 *   - For methods like getDeviceAuthToken, householdId is a BODY arg,
 *     not a header field. Callers pass it via `args`; the envelope
 *     builder does not duplicate it into the credentials block.
 */

export const SMAPI_NAMESPACE = 'http://www.sonos.com/Services/1.1';
export const SMAPI_SOAP_ACTION_PREFIX = 'http://www.sonos.com/Services/1.1#';

/**
 * Mimic Sonos's own iOS app User-Agent. The OEM docs don't mandate a UA,
 * but some partner backends (Apple Music in particular) silently degrade
 * responses for unrecognised clients. The iPhone7,1 fingerprint matches
 * what real Sonos S2 controllers send.
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
    /**
     * Per OEM docs, always "Sonos" for requests originating from a
     * Sonos player. Exposed as a knob in case a future flow needs to
     * impersonate a different provider.
     */
    deviceProvider?: string;
    /**
     * Stored credentials for authenticated services. Omit entirely for
     * the pre-auth flow (getAppLink/getDeviceLinkCode/getDeviceAuthToken)
     * — the OEM spec requires no loginToken at all for those methods.
     */
    loginToken?: SmapiLoginToken;
}

export interface SmapiEnvelopeOptions {
    method: string;
    /**
     * Argument tag-name → value map. Values are XML-text-escaped, then
     * wrapped in `<s:{tag}>{value}</s:{tag}>` children of the method
     * element. For getDeviceAuthToken etc., callers pass `householdId`
     * here — it belongs in the body per OEM spec.
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
 * Build the inner <s:credentials> SOAP header block exactly as the OEM
 * docs specify. Returned without the outer <soap:Header> wrapper so it
 * can be unit-tested in isolation.
 */
export function buildSmapiHeaderXml(opts: SmapiCredentialsOptions): string {
    const provider = opts.deviceProvider ?? 'Sonos';
    const parts: string[] = [
        `<s:credentials>`,
        `<s:deviceId>${escapeXmlText(opts.deviceId)}</s:deviceId>`,
        `<s:deviceProvider>${escapeXmlText(provider)}</s:deviceProvider>`,
    ];
    if (opts.loginToken) {
        parts.push(
            `<s:loginToken>`,
            `<s:token>${escapeXmlText(opts.loginToken.token)}</s:token>`,
            `<s:key>${escapeXmlText(opts.loginToken.key)}</s:key>`,
            `<s:householdId>${escapeXmlText(opts.loginToken.householdId)}</s:householdId>`,
            `</s:loginToken>`,
        );
    }
    parts.push(`</s:credentials>`);
    return parts.join('');
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
    // SOAPACTION must be a quoted URL per the OEM docs. Sample:
    //   SOAPACTION: "http://www.sonos.com/Services/1.1#getAppLink"
    return `"${SMAPI_SOAP_ACTION_PREFIX}${method}"`;
}
