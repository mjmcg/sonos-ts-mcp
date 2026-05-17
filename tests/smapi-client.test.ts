import { describe, it, expect, vi } from 'vitest';
import { SMAPIClient, summarizeResponseBody } from '../src/services/smapi-client.js';
import type { MusicServiceDescriptor } from '../src/types/music-services.js';

function descriptor(authType: MusicServiceDescriptor['authType']): MusicServiceDescriptor {
    return {
        id: 204,
        name: 'Apple Music',
        version: '1.1',
        uri: 'http://example.invalid/smapi',
        secureUri: 'https://example.invalid/smapi',
        containerType: 'MService',
        capabilities: 0,
        authType,
        pollInterval: 30,
        serviceType: '204',
    };
}

function emptyMetadataResponse(): string {
    return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <getMetadataResponse xmlns="http://www.sonos.com/Services/1.1">
      <getMetadataResult>
        <index>0</index>
        <count>0</count>
        <total>0</total>
      </getMetadataResult>
    </getMetadataResponse>
  </s:Body>
</s:Envelope>`;
}

describe('SMAPIClient.getMetadata', () => {
    it('posts a SOAP Header containing credentials with deviceId + deviceProvider', async () => {
        const fetchImpl = vi.fn(async () => {
            return new Response(emptyMetadataResponse(), {
                status: 200,
                headers: { 'Content-Type': 'text/xml' },
            });
        }) as unknown as typeof fetch;

        const client = new SMAPIClient(descriptor('Anonymous'), {
            deviceId: 'RINCON_AAA',
            fetchImpl,
        });

        await client.getMetadata('root', 0, 100);

        expect(fetchImpl).toHaveBeenCalledOnce();
        const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
        const body = init.body as string;

        // Header structure (the bug we're fixing).
        expect(body).toMatch(/<s:Header>[\s\S]*<credentials[\s\S]*<\/credentials>[\s\S]*<\/s:Header>/);
        expect(body).toContain('<deviceId>RINCON_AAA</deviceId>');
        expect(body).toContain('<deviceProvider>Sonos</deviceProvider>');
        // SOAPACTION wrapping in quotes per spec.
        const headers = init.headers as Record<string, string>;
        expect(headers.SOAPACTION).toBe('"http://www.sonos.com/Services/1.1#getMetadata"');
    });

    it('adds <context></context> to credentials for DeviceLink/AppLink services', async () => {
        const fetchImpl = vi.fn(async () =>
            new Response(emptyMetadataResponse(), { status: 200 })
        ) as unknown as typeof fetch;

        const client = new SMAPIClient(descriptor('AppLink'), {
            deviceId: 'RINCON_AAA',
            fetchImpl,
        });
        await client.getMetadata('root', 0, 100);

        const body = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
        expect(body).toContain('<context></context>');
    });

    it('emits loginToken block when configured', async () => {
        const fetchImpl = vi.fn(async () =>
            new Response(emptyMetadataResponse(), { status: 200 })
        ) as unknown as typeof fetch;

        const client = new SMAPIClient(descriptor('AppLink'), {
            deviceId: 'RINCON_AAA',
            householdId: 'Sonos_HH',
            loginToken: { token: 'TOK', key: 'KEY', householdId: 'Sonos_HH' },
            fetchImpl,
        });
        await client.getMetadata('root', 0, 100);

        const body = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
        expect(body).toContain('<loginToken>');
        expect(body).toContain('<token>TOK</token>');
        expect(body).toContain('<key>KEY</key>');
        expect(body).toContain('<householdId>Sonos_HH</householdId>');
    });

    it('parses mediaCollection and mediaMetadata children', async () => {
        const xml = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <ns:getMetadataResponse xmlns:ns="http://www.sonos.com/Services/1.1">
      <ns:getMetadataResult>
        <ns:index>0</ns:index>
        <ns:count>2</ns:count>
        <ns:total>2</ns:total>
        <ns:mediaCollection>
          <ns:id>cat:rock</ns:id>
          <ns:itemType>category</ns:itemType>
          <ns:title>Rock</ns:title>
          <ns:canEnumerate>true</ns:canEnumerate>
          <ns:canPlay>false</ns:canPlay>
        </ns:mediaCollection>
        <ns:mediaMetadata>
          <ns:id>track:1</ns:id>
          <ns:itemType>track</ns:itemType>
          <ns:title>One</ns:title>
          <ns:mimeType>audio/aac</ns:mimeType>
        </ns:mediaMetadata>
      </ns:getMetadataResult>
    </ns:getMetadataResponse>
  </s:Body>
</s:Envelope>`;
        const fetchImpl = vi.fn(async () => new Response(xml, { status: 200 })) as unknown as typeof fetch;

        const client = new SMAPIClient(descriptor('Anonymous'), {
            deviceId: 'RINCON_AAA',
            fetchImpl,
        });
        const result = await client.getMetadata('root', 0, 100);

        expect(result.total).toBe(2);
        expect(result.items).toHaveLength(2);
        const titles = result.items.map(i => i.title);
        expect(titles).toContain('Rock');
        expect(titles).toContain('One');
    });

    it('returns empty result on HTTP 500 SOAP fault (logs and continues)', async () => {
        const fault = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <s:Fault>
      <faultcode>Client.LoginUnauthorized</faultcode>
      <faultstring>not linked</faultstring>
    </s:Fault>
  </s:Body>
</s:Envelope>`;
        const fetchImpl = vi.fn(async () => new Response(fault, { status: 500 })) as unknown as typeof fetch;
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const client = new SMAPIClient(descriptor('AppLink'), {
            deviceId: 'RINCON_AAA',
            fetchImpl,
        });
        const result = await client.getMetadata('root', 0, 100);

        expect(result.items).toEqual([]);
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });

    it('detects SOAP faults on HTTP 200 responses (does not silently return empty)', async () => {
        // Some services return 200 OK with a Fault embedded — previously
        // our code silently called parseMetadataResponse on the fault
        // body and returned an empty result, masking the real error.
        const fault200 = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <s:Fault>
      <faultcode>Client.NOT_LINKED_RETRY</faultcode>
      <faultstring>Account not yet linked, retry</faultstring>
    </s:Fault>
  </s:Body>
</s:Envelope>`;
        const fetchImpl = vi.fn(async () => new Response(fault200, { status: 200 })) as unknown as typeof fetch;
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const client = new SMAPIClient(descriptor('DeviceLink'), {
            deviceId: 'RINCON_AAA',
            fetchImpl,
        });
        const result = await client.getMetadata('root', 0, 100);

        expect(result.items).toEqual([]);
        // Crucial: lastFault is set, so callers can surface a real error.
        expect(client.lastFault?.faultCode).toBe('Client.NOT_LINKED_RETRY');
        expect(client.lastFault?.faultString).toBe('Account not yet linked, retry');
        errorSpy.mockRestore();
    });

    it('clears lastFault on a successful call', async () => {
        let call = 0;
        const fetchImpl = vi.fn(async () => {
            call++;
            if (call === 1) {
                return new Response(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
                    <s:Body><s:Fault>
                      <faultcode>Client.Failure</faultcode>
                      <faultstring>bad</faultstring>
                    </s:Fault></s:Body></s:Envelope>`, { status: 500 });
            }
            return new Response(emptyMetadataResponse(), { status: 200 });
        }) as unknown as typeof fetch;
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const client = new SMAPIClient(descriptor('AppLink'), {
            deviceId: 'RINCON_AAA',
            fetchImpl,
        });
        await client.getMetadata('root', 0, 100);
        expect(client.lastFault).not.toBeNull();

        await client.getMetadata('root', 0, 100);
        expect(client.lastFault).toBeNull();
        errorSpy.mockRestore();
    });

    it('retries getDeviceAuthToken with backoff on NOT_LINKED_RETRY', async () => {
        const transientFault = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body><s:Fault>
    <faultcode>Client.NOT_LINKED_RETRY</faultcode>
    <faultstring>retry</faultstring>
  </s:Fault></s:Body>
</s:Envelope>`;
        const successResponse = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <getDeviceAuthTokenResponse xmlns="http://www.sonos.com/Services/1.1">
      <getDeviceAuthTokenResult>
        <authToken>FINAL_TOKEN</authToken>
        <privateKey>FINAL_KEY</privateKey>
      </getDeviceAuthTokenResult>
    </getDeviceAuthTokenResponse>
  </s:Body>
</s:Envelope>`;

        let call = 0;
        const fetchImpl = vi.fn(async () => {
            call++;
            return call < 3
                ? new Response(transientFault, { status: 500 })
                : new Response(successResponse, { status: 200 });
        }) as unknown as typeof fetch;
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const client = new SMAPIClient(descriptor('DeviceLink'), {
            deviceId: 'RINCON_AAA',
            fetchImpl,
        });
        // Fast backoff for tests.
        const pair = await client.getDeviceAuthToken('Sonos_HH', 'CODE', 'RINCON_AAA', {
            maxAttempts: 5,
            baseDelayMs: 1,
        });

        expect(pair).toEqual({ authToken: 'FINAL_TOKEN', privateKey: 'FINAL_KEY' });
        expect(call).toBe(3);
        expect(client.lastFault).toBeNull();
        errorSpy.mockRestore();
    });

    it('getDeviceAuthToken does not retry on non-transient faults', async () => {
        const terminalFault = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body><s:Fault>
    <faultcode>Client.LoginUnauthorized</faultcode>
    <faultstring>link code expired</faultstring>
  </s:Fault></s:Body>
</s:Envelope>`;
        const fetchImpl = vi.fn(async () =>
            new Response(terminalFault, { status: 500 })
        ) as unknown as typeof fetch;
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const client = new SMAPIClient(descriptor('DeviceLink'), {
            deviceId: 'RINCON_AAA',
            fetchImpl,
        });
        const pair = await client.getDeviceAuthToken('Sonos_HH', 'CODE', 'RINCON_AAA', {
            maxAttempts: 5,
            baseDelayMs: 1,
        });

        expect(pair).toBeNull();
        // Just one call — no retry on a terminal fault.
        expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
        expect(client.lastFault?.faultCode).toBe('Client.LoginUnauthorized');
        errorSpy.mockRestore();
    });

    it('getDeviceAuthToken gives up after maxAttempts on persistent transient fault', async () => {
        const transientFault = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body><s:Fault>
    <faultcode>Client.NOT_LINKED_RETRY</faultcode>
    <faultstring>still waiting</faultstring>
  </s:Fault></s:Body>
</s:Envelope>`;
        const fetchImpl = vi.fn(async () =>
            new Response(transientFault, { status: 500 })
        ) as unknown as typeof fetch;
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const client = new SMAPIClient(descriptor('DeviceLink'), {
            deviceId: 'RINCON_AAA',
            fetchImpl,
        });
        const pair = await client.getDeviceAuthToken('Sonos_HH', 'CODE', 'RINCON_AAA', {
            maxAttempts: 3,
            baseDelayMs: 1,
        });

        expect(pair).toBeNull();
        expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
        // Caller can read lastFault to surface a useful message.
        expect(client.lastFault?.faultCode).toBe('Client.NOT_LINKED_RETRY');
        errorSpy.mockRestore();
    });

    it('retries with refreshed token on Client.TokenRefreshRequired', async () => {
        const refreshFault = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <s:Fault>
      <faultcode>Client.TokenRefreshRequired</faultcode>
      <faultstring>refresh me</faultstring>
      <detail>
        <refreshAuthTokenResult xmlns="http://www.sonos.com/Services/1.1">
          <authToken>NEW_TOK</authToken>
          <privateKey>NEW_KEY</privateKey>
        </refreshAuthTokenResult>
      </detail>
    </s:Fault>
  </s:Body>
</s:Envelope>`;

        let call = 0;
        const fetchImpl = vi.fn(async () => {
            call++;
            return call === 1
                ? new Response(refreshFault, { status: 500 })
                : new Response(emptyMetadataResponse(), { status: 200 });
        }) as unknown as typeof fetch;

        const onTokenRefresh = vi.fn();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const client = new SMAPIClient(descriptor('AppLink'), {
            deviceId: 'RINCON_AAA',
            householdId: 'Sonos_HH',
            loginToken: { token: 'OLD_TOK', key: 'OLD_KEY', householdId: 'Sonos_HH' },
            onTokenRefresh,
            fetchImpl,
        });
        const result = await client.getMetadata('root', 0, 100);

        expect(onTokenRefresh).toHaveBeenCalledWith({
            token: 'NEW_TOK',
            key: 'NEW_KEY',
            householdId: 'Sonos_HH',
        });
        // Second call should have used the refreshed token.
        const retryBody = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1].body as string;
        expect(retryBody).toContain('<token>NEW_TOK</token>');
        expect(retryBody).toContain('<key>NEW_KEY</key>');
        expect(result.items).toEqual([]);
        errorSpy.mockRestore();
    });

    it('exposes lastResponseBody for diagnostic surfacing', async () => {
        // 200 OK with neither fault nor expected response shape — exactly
        // the "no SMAPI fault" case auth_complete needs to surface.
        const weirdResponse = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <getDeviceAuthTokenResponse xmlns="http://www.sonos.com/Services/1.1">
      <getDeviceAuthTokenResult>
        <!-- service returned the wrapper but no token/key -->
      </getDeviceAuthTokenResult>
    </getDeviceAuthTokenResponse>
  </s:Body>
</s:Envelope>`;
        const fetchImpl = vi.fn(async () =>
            new Response(weirdResponse, { status: 200 })
        ) as unknown as typeof fetch;
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const client = new SMAPIClient(descriptor('DeviceLink'), {
            deviceId: 'RINCON_AAA',
            fetchImpl,
        });
        const result = await client.getDeviceAuthToken('Sonos_HH', 'CODE', 'RINCON_AAA', {
            maxAttempts: 1,
            baseDelayMs: 1,
        });

        expect(result).toBeNull();
        expect(client.lastFault).toBeNull();
        expect(client.lastResponseBody).toContain('getDeviceAuthTokenResult');
        errorSpy.mockRestore();
    });
});

describe('summarizeResponseBody', () => {
    it('returns "(empty response)" for null/undefined/empty', () => {
        expect(summarizeResponseBody(null)).toBe('(empty response)');
        expect(summarizeResponseBody(undefined)).toBe('(empty response)');
        expect(summarizeResponseBody('')).toBe('(empty response)');
    });

    it('redacts sensitive credential values while keeping tag structure', () => {
        const xml = `<getDeviceAuthTokenResponse>
  <authToken>secrettoken12345</authToken>
  <privateKey>secretkey6789</privateKey>
  <key>shortk</key>
  <sessionId>sess-abc</sessionId>
  <linkCode>USERCODE</linkCode>
</getDeviceAuthTokenResponse>`;
        const out = summarizeResponseBody(xml);
        expect(out).not.toContain('secrettoken12345');
        expect(out).not.toContain('secretkey6789');
        expect(out).not.toContain('shortk');
        expect(out).not.toContain('sess-abc');
        // Tags themselves are preserved so the reader can see the structure.
        expect(out).toContain('<authToken>');
        expect(out).toContain('</authToken>');
        // Link code is NOT redacted — it's short-lived and useful to verify.
        expect(out).toContain('<linkCode>USERCODE</linkCode>');
    });

    it('redacts using length-encoded marker for long values', () => {
        const xml = '<authToken>thisIsALongTokenValueOver8Chars</authToken>';
        expect(summarizeResponseBody(xml)).toContain('<redacted:31>');
    });

    it('truncates very long responses', () => {
        const long = '<root>' + 'x'.repeat(2000) + '</root>';
        const out = summarizeResponseBody(long);
        expect(out.length).toBeLessThan(700);
        expect(out).toContain('truncated');
    });

    it('handles namespace-prefixed tags', () => {
        const xml = '<ns:authToken xmlns:ns="urn:foo">secrettoken</ns:authToken>';
        const out = summarizeResponseBody(xml);
        expect(out).not.toContain('secrettoken');
        expect(out).toContain('ns:authToken');
    });
});
