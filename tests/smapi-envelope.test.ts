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
        // svrooij's docs are explicit about this exact string. Apple
        // Music in particular gates on it.
        expect(SMAPI_USER_AGENT).toContain('Sonos/');
        expect(SMAPI_USER_AGENT).toContain('iPhone7,1');
        expect(SMAPI_USER_AGENT).toContain('iOS/');
    });
});

describe('buildSmapiHeaderXml', () => {
    it('emits <s:context> with <s:timezone> as a sibling of <s:credentials>', () => {
        const xml = buildSmapiHeaderXml({
            deviceId: 'RINCON_AAA',
            householdId: 'Sonos_HH',
        });

        // Both elements present
        expect(xml).toContain('<s:context>');
        expect(xml).toContain('<s:timezone>+00:00</s:timezone>');
        expect(xml).toContain('</s:context>');
        expect(xml).toContain('<s:credentials>');

        // Context closes BEFORE credentials opens — sibling relationship
        const contextEnd = xml.indexOf('</s:context>');
        const credsStart = xml.indexOf('<s:credentials>');
        expect(contextEnd).toBeLessThan(credsStart);
    });

    it('always includes <s:loginToken> with householdId, regardless of auth state', () => {
        const xml = buildSmapiHeaderXml({
            deviceId: 'RINCON_AAA',
            householdId: 'Sonos_HH',
        });

        // The svrooij-documented shape: loginToken is ALWAYS present.
        // During pre-auth, token and key are empty elements; householdId
        // is always populated.
        expect(xml).toContain('<s:loginToken>');
        expect(xml).toContain('<s:token></s:token>');
        expect(xml).toContain('<s:key></s:key>');
        expect(xml).toContain('<s:householdId>Sonos_HH</s:householdId>');
        expect(xml).toContain('</s:loginToken>');
    });

    it('populates token + key inside loginToken when supplied', () => {
        const xml = buildSmapiHeaderXml({
            deviceId: 'RINCON_AAA',
            householdId: 'Sonos_HH',
            loginToken: { token: 'TOK', key: 'KEY' },
        });

        expect(xml).toContain('<s:token>TOK</s:token>');
        expect(xml).toContain('<s:key>KEY</s:key>');
        // Household stays in the same place.
        expect(xml).toContain('<s:householdId>Sonos_HH</s:householdId>');
    });

    it('uses prefix s: on every SMAPI element, not a default xmlns', () => {
        const xml = buildSmapiHeaderXml({
            deviceId: 'RINCON_AAA',
            householdId: 'Sonos_HH',
        });

        // The previous (sonoscli-style) shape was <credentials xmlns="...">
        // with a default namespace. svrooij's documented shape is explicit
        // s: prefix throughout.
        expect(xml).not.toContain('xmlns=');
        expect(xml).toMatch(/<s:credentials>/);
        expect(xml).toMatch(/<s:deviceId>/);
    });

    it('does NOT include <deviceProvider> (sonoscli quirk, not documented)', () => {
        const xml = buildSmapiHeaderXml({
            deviceId: 'RINCON_AAA',
            householdId: 'Sonos_HH',
        });

        expect(xml).not.toContain('deviceProvider');
    });

    it('honors timezone override', () => {
        const xml = buildSmapiHeaderXml({
            deviceId: 'RINCON_AAA',
            householdId: 'Sonos_HH',
            timezone: '-08:00',
        });
        expect(xml).toContain('<s:timezone>-08:00</s:timezone>');
    });

    it('escapes XML-special characters in deviceId/householdId/token', () => {
        const xml = buildSmapiHeaderXml({
            deviceId: 'A&B<C>',
            householdId: 'H&H',
            loginToken: { token: '<x>', key: '&y&' },
        });
        expect(xml).toContain('<s:deviceId>A&amp;B&lt;C&gt;</s:deviceId>');
        expect(xml).toContain('<s:householdId>H&amp;H</s:householdId>');
        expect(xml).toContain('<s:token>&lt;x&gt;</s:token>');
        expect(xml).toContain('<s:key>&amp;y&amp;</s:key>');
    });
});

describe('buildSmapiEnvelope', () => {
    it('declares both soap: and s: namespaces on the Envelope element', () => {
        const env = buildSmapiEnvelope({
            method: 'getMetadata',
            args: { id: 'root', index: 0, count: 100 },
            credentials: { deviceId: 'RINCON_AAA', householdId: 'Sonos_HH' },
        });

        expect(env).toContain('xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"');
        expect(env).toContain(`xmlns:s="${SMAPI_NAMESPACE}"`);
        // Old shape used s: for both — make sure we're not regressing.
        expect(env).not.toContain('<s:Envelope');
    });

    it('puts context+credentials in soap:Header, not soap:Body', () => {
        const env = buildSmapiEnvelope({
            method: 'getMetadata',
            args: { id: 'root', index: 0, count: 100 },
            credentials: { deviceId: 'RINCON_AAA', householdId: 'Sonos_HH' },
        });

        const headerStart = env.indexOf('<soap:Header>');
        const headerEnd = env.indexOf('</soap:Header>');
        const bodyStart = env.indexOf('<soap:Body>');
        const credsAt = env.indexOf('<s:credentials>');
        const contextAt = env.indexOf('<s:context>');

        expect(headerStart).toBeGreaterThan(-1);
        expect(contextAt).toBeGreaterThan(headerStart);
        expect(contextAt).toBeLessThan(headerEnd);
        expect(credsAt).toBeGreaterThan(headerStart);
        expect(credsAt).toBeLessThan(headerEnd);
        expect(headerEnd).toBeLessThan(bodyStart);

        // Body must NOT contain credentials (the v1 bug).
        const body = env.slice(bodyStart);
        expect(body).not.toContain('<s:credentials');
        expect(body).not.toContain('<credentials');
    });

    it('emits the method element + args with s: prefix in soap:Body', () => {
        const env = buildSmapiEnvelope({
            method: 'getDeviceAuthToken',
            args: { householdId: 'Sonos_HH', linkCode: 'ABC', linkDeviceId: 'XYZ' },
            credentials: { deviceId: 'RINCON_AAA', householdId: 'Sonos_HH' },
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
            credentials: { deviceId: 'RINCON_AAA', householdId: 'Sonos_HH' },
        });
        expect(env).toContain('<s:term>AT&amp;T &lt; Co</s:term>');
    });

    it('coerces boolean and number args to strings', () => {
        const env = buildSmapiEnvelope({
            method: 'foo',
            args: { recursive: true, index: 0 },
            credentials: { deviceId: 'RINCON_AAA', householdId: 'Sonos_HH' },
        });
        expect(env).toContain('<s:recursive>1</s:recursive>');
        expect(env).toContain('<s:index>0</s:index>');
    });

    it('matches the exact shape documented in sonos-api-docs', () => {
        // Snapshot-style assertion against the svrooij-canonical
        // structure for getDeviceLinkCode. This catches future regressions
        // that subtly change the envelope.
        const env = buildSmapiEnvelope({
            method: 'getDeviceLinkCode',
            args: { householdId: 'Sonos_HH' },
            credentials: { deviceId: 'RINCON_AAA', householdId: 'Sonos_HH' },
        });

        // Normalize whitespace for comparison.
        const flat = env.replace(/\s+/g, ' ');
        expect(flat).toContain(
            '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ' +
            `xmlns:s="${SMAPI_NAMESPACE}"><soap:Header>` +
            '<s:context><s:timezone>+00:00</s:timezone></s:context>' +
            '<s:credentials><s:deviceId>RINCON_AAA</s:deviceId>' +
            '<s:loginToken><s:token></s:token><s:key></s:key>' +
            '<s:householdId>Sonos_HH</s:householdId></s:loginToken>' +
            '</s:credentials></soap:Header><soap:Body>' +
            '<s:getDeviceLinkCode><s:householdId>Sonos_HH</s:householdId></s:getDeviceLinkCode>' +
            '</soap:Body></soap:Envelope>'
        );
    });
});
