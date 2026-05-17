import { describe, it, expect } from 'vitest';
import {
    buildCredentialsXml,
    buildSmapiEnvelope,
    buildSmapiSoapAction,
    SMAPI_NAMESPACE,
} from '../src/services/smapi/envelope.js';

describe('buildSmapiSoapAction', () => {
    it('wraps the action URL in literal double quotes', () => {
        expect(buildSmapiSoapAction('getMetadata'))
            .toBe('"http://www.sonos.com/Services/1.1#getMetadata"');
    });
});

describe('buildCredentialsXml', () => {
    it('anonymous: emits deviceId + deviceProvider only', () => {
        const xml = buildCredentialsXml({ deviceId: 'RINCON_AAA' });
        expect(xml).toContain(`<credentials xmlns="${SMAPI_NAMESPACE}">`);
        expect(xml).toContain('<deviceId>RINCON_AAA</deviceId>');
        expect(xml).toContain('<deviceProvider>Sonos</deviceProvider>');
        expect(xml).not.toContain('<context>');
        expect(xml).not.toContain('<loginToken>');
    });

    it('authenticated-service (no token yet): adds <context></context>', () => {
        const xml = buildCredentialsXml({
            deviceId: 'RINCON_AAA',
            includeContext: true,
        });
        expect(xml).toContain('<context></context>');
        expect(xml).not.toContain('<loginToken>');
    });

    it('authenticated-service with token: emits loginToken block', () => {
        const xml = buildCredentialsXml({
            deviceId: 'RINCON_AAA',
            loginToken: {
                token: 'TOK',
                key: 'KEY',
                householdId: 'Sonos_HH',
            },
        });
        expect(xml).toContain('<context></context>');
        expect(xml).toContain('<loginToken>');
        expect(xml).toContain('<token>TOK</token>');
        expect(xml).toContain('<key>KEY</key>');
        expect(xml).toContain('<householdId>Sonos_HH</householdId>');
    });

    it('escapes XML-special characters in deviceId and token', () => {
        const xml = buildCredentialsXml({
            deviceId: 'A&B<C>',
            loginToken: { token: '"q"', key: 'k', householdId: 'H' },
        });
        expect(xml).toContain('<deviceId>A&amp;B&lt;C&gt;</deviceId>');
        // Element text only escapes &, <, > — not quotes (legal in PCDATA).
        expect(xml).toContain('<token>"q"</token>');
    });

    it('emits sessionId as a sibling when supplied (legacy UserID flow)', () => {
        const xml = buildCredentialsXml({
            deviceId: 'RINCON_AAA',
            sessionId: 'SESS-123',
        });
        expect(xml).toContain('<sessionId>SESS-123</sessionId>');
    });
});

describe('buildSmapiEnvelope', () => {
    it('puts credentials in s:Header, not s:Body', () => {
        const env = buildSmapiEnvelope({
            method: 'getMetadata',
            args: { id: 'root', index: 0, count: 100 },
            credentials: { deviceId: 'RINCON_AAA' },
        });

        // Critical structural assertion: credentials precedes Body.
        const headerStart = env.indexOf('<s:Header>');
        const headerEnd = env.indexOf('</s:Header>');
        const bodyStart = env.indexOf('<s:Body>');
        const credsAt = env.indexOf('<credentials');

        expect(headerStart).toBeGreaterThan(-1);
        expect(credsAt).toBeGreaterThan(headerStart);
        expect(credsAt).toBeLessThan(headerEnd);
        expect(headerEnd).toBeLessThan(bodyStart);

        // And the Body does NOT contain credentials (the bug we're fixing).
        const body = env.slice(bodyStart);
        expect(body).not.toContain('<credentials');
    });

    it('renders args as direct child elements of the method tag', () => {
        const env = buildSmapiEnvelope({
            method: 'getMetadata',
            args: { id: 'root', index: 0, count: 100 },
            credentials: { deviceId: 'RINCON_AAA' },
        });

        expect(env).toContain('<getMetadata xmlns="http://www.sonos.com/Services/1.1">');
        expect(env).toContain('<id>root</id>');
        expect(env).toContain('<index>0</index>');
        expect(env).toContain('<count>100</count>');
        expect(env).toContain('</getMetadata>');
    });

    it('XML-escapes arg values', () => {
        const env = buildSmapiEnvelope({
            method: 'search',
            args: { id: 'search:all', term: 'AT&T < Co', index: 0, count: 10 },
            credentials: { deviceId: 'RINCON_AAA' },
        });
        expect(env).toContain('<term>AT&amp;T &lt; Co</term>');
    });

    it('coerces boolean and number args to strings', () => {
        const env = buildSmapiEnvelope({
            method: 'foo',
            args: { recursive: true, index: 0 },
            credentials: { deviceId: 'RINCON_AAA' },
        });
        expect(env).toContain('<recursive>1</recursive>');
        expect(env).toContain('<index>0</index>');
    });
});
