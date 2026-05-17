import { describe, it, expect, vi } from 'vitest';
import { SMAPIClient } from '../src/services/smapi-client.js';
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
});
