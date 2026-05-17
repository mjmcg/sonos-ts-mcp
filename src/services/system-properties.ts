import { BaseService } from './base-service.js';
import { RequestBuilder } from '../soap/request-builder.js';
import { XmlParser } from '../soap/response-parser.js';

/**
 * SystemProperties UPnP service.
 *
 * Provides typed get/set access to the player's persistent string
 * variables. The variable we care about for SMAPI is `R_TrialZPSerial` —
 * Sonos's preferred short device identifier for music-service
 * registration. It falls back to the player's UDN when not set, but
 * SMAPI accepts either.
 */
export class SystemPropertiesService extends BaseService {
    protected getServiceType(): string {
        return 'urn:schemas-upnp-org:service:SystemProperties:1';
    }

    protected getControlEndpoint(): string {
        return '/SystemProperties/Control';
    }

    /**
     * Read a persistent string variable from the player.
     * Returns null when the variable is unset or the call fails.
     */
    async getString(variableName: string): Promise<string | null> {
        const trimmed = variableName.trim();
        if (!trimmed) return null;

        const body = RequestBuilder.buildSimpleBody({ VariableName: trimmed });
        const response = await this.callAction('GetString', body);

        if (!response.success || !response.body) {
            return null;
        }

        const value = XmlParser.extractValue(response.body, 'StringValue');
        return value !== null ? value.trim() : null;
    }
}
