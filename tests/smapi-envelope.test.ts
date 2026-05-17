import { describe, it, expect } from 'vitest';
import {
    buildSmapiHeaderXml,
    buildSmapiEnvelope,
    buildSmapiSoapAction,
    SMAPI_NAMESPACE,
    SMAPI_USER_AGENT,
} from '../src/services/smapi/envelope.js';

describe('buildSmapiSoapAction', () => {
    it('wraps the action URL in literal double quotes', () => {
        expect(buildSmapiSoapAction('getMetadata'))
            .toBe('"http://www.sonos.com/Services/1.1#getMetadata"');
    });
});

describe('SMAPI_USER_AGENT', () => {
    it('matches the documented iPhone7,1 fingerprint', () => {
        // The OEM docs don't mandate a UA, but partner backends
        // (Apple Music in particular) gate on a Sonos-shape UA. Match
        // the iPhone7,1 fingerprint that real S2 controllers send.
        expect(SMAPI_USER_AGENT).toContain('Sonos/');
        expect(SMAPI_USER_AGENT).toContain('iPhone7,1');
        expect(SMAPI_USER_AGENT).toContain('iOS/');
    });
});

describe('buildSmapiHeaderXml', () => {
    it('emits <s:credentials> with deviceId + deviceProvider and no loginToken when unauthenticated', () => {
        // Per OEM docs (docs.sonos.com/docs/getapplink,
        // docs.sonos.com/docs/getdeviceauthtoken), the pre-auth flow
        // takes deviceId + deviceProvider only. No loginToken element.
        const xml = buildSmapiHeaderXml({
            deviceId: 'RINCON_AAA',
        });

        expect(xml).toContain('<s:credentials>');
        expect(xml).toContain('<s:deviceId>RINCON_AAA</s:deviceId>');
        expect(xml).toContain('<s:deviceProvider>Sonos</s:deviceProvider>');
        expect(xml).toContain('</s:credentials>');
        expect(xml).not.toContain('<s:loginToken');
        // No context/timezone block either — not in the OEM spec.
        expect(xml).not.toContain('<s:context>');
        expect(xml).not.toContain('<s:timezone>');
    });

    it('honors a deviceProvider override', () => {
        const xml = buildSmapiHeaderXml({
            deviceId: 'RINCON_AAA',
            deviceProvider: 'CustomProvider',
        });
        expect(xml).toContain('<s:deviceProvider>CustomProvider</s:deviceProvider>');
    });

    it('emits a populated <s:loginToken> when a stored pair is provided', () => {
        const xml = buildSmapiHeaderXml({
            deviceId: 'RINCON_AAA',
            loginToken: { token: 'TOK', key: 'KEY', householdId: 'Sonos_HH' },
        });

        // OEM-shape ordering: credentials > deviceId, deviceProvider,
        // then loginToken (which holds token/key/householdId).
        expect(xml).toContain('<s:credentials>');
        expect(xml).toContain('<s:deviceId>RINCON_AAA</s:deviceId>');
        expect(xml).toContain('<s:deviceProvider>Sonos</s:deviceProvider>');
        expect(xml).toContain('<s:loginToken>');
        expect(xml).toContain('<s:token>TOK</s:token>');
        expect(xml).toContain('<s:key>KEY</s:key>');
        expect(xml).toContain('<s:householdId>Sonos_HH</s:householdId>');
        expect(xml).toContain('</s:loginToken>');
        expect(xml).toContain('</s:credentials>');
    });

    it('uses prefix s: on every SMAPI element, not a default xmlns', () => {
        const xml = buildSmapiHeaderXml({
            deviceId: 'RINCON_AAA',
        });

        // Avoid the sonoscli-style `<credentials xmlns="...">` default
        // namespace; OEM examples are happy with explicit prefixes and
        // it keeps namespaces consistent across header + body.
        expect(xml).not.toContain('xmlns=');
        expect(xml).toMatch(/<s:credentials>/);
        expect(xml).toMatch(/<s:deviceId>/);
    });

    it('escapes XML-special characters in deviceId and token fields', () => {
        const xml = buildSmapiHeaderXml({
            deviceId: 'A&B<C>',
            loginToken: { token: '<x>', key: '&y&', householdId: 'H&H' },
        });
        expect(xml).toContain('<s:deviceId>A&amp;B&lt;C&gt;</s:deviceId>');
        expect(xml).toContain('<s:token>&lt;x&gt;</s:token>');
        expect(xml).toContain('<s:key>&amp;y&amp;</s:key>');
        expect(xml).toContain('<s:householdId>H&amp;H</s:householdId>');
    });
});

describe('buildSmapiEnvelope', () => {
    it('declares both soap: and s: namespaces on the Envelope element', () => {
        const env = buildSmapiEnvelope({
            method: 'getMetadata',
            args: { id: 'root', index: 0, count: 100 },
            credentials: { deviceId: 'RINCON_AAA' },
        });

        expect(env).toContain('xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"');
        expect(env).toContain(`xmlns:s="${SMAPI_NAMESPACE}"`);
        // Old shape used s: for both — make sure we're not regressing.
        expect(env).not.toContain('<s:Envelope');
    });

    it('puts credentials in soap:Header, not soap:Body', () => {
        const env = buildSmapiEnvelope({
            method: 'getDeviceAuthToken',
            args: { householdId: 'Sonos_HH', linkCode: 'ABC', linkDeviceId: 'XYZ' },
            credentials: { deviceId: 'RINCON_AAA' },
        });

        const headerStart = env.indexOf('<soap:Header>');
        const headerEnd = env.indexOf('</soap:Header>');
        const bodyStart = env.indexOf('<soap:Body>');
        const credsAt = env.indexOf('<s:credentials>');

        expect(headerStart).toBeGreaterThan(-1);
        expect(credsAt).toBeGreaterThan(headerStart);
        expect(credsAt).toBeLessThan(headerEnd);
        expect(headerEnd).toBeLessThan(bodyStart);

        // Body must NOT contain credentials.
        const body = env.slice(bodyStart);
        expect(body).not.toContain('<s:credentials');
        expect(body).not.toContain('<credentials');
    });

    it('emits the method element + args with s: prefix in soap:Body', () => {
        const env = buildSmapiEnvelope({
            method: 'getDeviceAuthToken',
            args: { householdId: 'Sonos_HH', linkCode: 'ABC', linkDeviceId: 'XYZ' },
            credentials: { deviceId: 'RINCON_AAA' },
        });

        expect(env).toContain('<s:getDeviceAuthToken>');
        expect(env).toContain('<s:householdId>Sonos_HH</s:householdId>');
        expect(env).toContain('<s:linkCode>ABC</s:linkCode>');
        expect(env).toContain('<s:linkDeviceId>XYZ</s:linkDeviceId>');
        expect(env).toContain('</s:getDeviceAuthToken>');
    });

    it('XML-escapes arg values', () => {
        const env = buildSmapiEnvelope({
            method: 'search',
            args: { id: 'search:all', term: 'AT&T < Co', index: 0, count: 10 },
            credentials: { deviceId: 'RINCON_AAA' },
        });
        expect(env).toContain('<s:term>AT&amp;T &lt; Co</s:term>');
    });

    it('coerces boolean and number args to strings', () => {
        const env = buildSmapiEnvelope({
            method: 'foo',
            args: { recursive: true, index: 0 },
            credentials: { deviceId: 'RINCON_AAA' },
        });
        expect(env).toContain('<s:recursive>1</s:recursive>');
        expect(env).toContain('<s:index>0</s:index>');
    });

    it('matches the OEM-documented shape for getDeviceAuthToken', () => {
        // Snapshot-style assertion against the docs.sonos.com canonical
        // structure: credentials carries deviceId + deviceProvider only,
        // householdId is a BODY arg (not a header field).
        const env = buildSmapiEnvelope({
            method: 'getDeviceAuthToken',
            args: { householdId: 'Sonos_HH', linkCode: 'CODE', linkDeviceId: 'XYZ' },
            credentials: { deviceId: 'RINCON_AAA' },
        });

        const flat = env.replace(/\s+/g, ' ');
        expect(flat).toContain(
            '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ' +
            `xmlns:s="${SMAPI_NAMESPACE}"><soap:Header>` +
            '<s:credentials>' +
            '<s:deviceId>RINCON_AAA</s:deviceId>' +
            '<s:deviceProvider>Sonos</s:deviceProvider>' +
            '</s:credentials></soap:Header><soap:Body>' +
            '<s:getDeviceAuthToken>' +
            '<s:householdId>Sonos_HH</s:householdId>' +
            '<s:linkCode>CODE</s:linkCode>' +
            '<s:linkDeviceId>XYZ</s:linkDeviceId>' +
            '</s:getDeviceAuthToken>' +
            '</soap:Body></soap:Envelope>'
        );
    });

    it('matches the OEM-documented shape for an authenticated getMetadata call', () => {
        // Same envelope wrapper, but the credentials block now carries
        // a populated <s:loginToken>.
        const env = buildSmapiEnvelope({
            method: 'getMetadata',
            args: { id: 'root', index: 0, count: 100 },
            credentials: {
                deviceId: 'RINCON_AAA',
                loginToken: { token: 'TOK', key: 'KEY', householdId: 'Sonos_HH' },
            },
        });

        const flat = env.replace(/\s+/g, ' ');
        expect(flat).toContain(
            '<s:credentials>' +
            '<s:deviceId>RINCON_AAA</s:deviceId>' +
            '<s:deviceProvider>Sonos</s:deviceProvider>' +
            '<s:loginToken>' +
            '<s:token>TOK</s:token>' +
            '<s:key>KEY</s:key>' +
            '<s:householdId>Sonos_HH</s:householdId>' +
            '</s:loginToken>' +
            '</s:credentials>'
        );
    });
});
