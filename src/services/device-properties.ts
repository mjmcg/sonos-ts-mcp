import { BaseService } from './base-service.js';
import { RequestBuilder } from '../soap/request-builder.js';
import { XmlParser } from '../soap/response-parser.js';

/**
 * DeviceProperties UPnP service.
 *
 * We use this primarily to obtain the household ID, which is required as
 * part of the SMAPI credentials header on every authenticated music
 * service request.
 */
export class DevicePropertiesService extends BaseService {
    protected getServiceType(): string {
        return 'urn:schemas-upnp-org:service:DeviceProperties:1';
    }

    protected getControlEndpoint(): string {
        return '/DeviceProperties/Control';
    }

    /**
     * Returns the Sonos household ID for this player (e.g. "Sonos_xxxxx").
     *
     * The household is set when the system is first configured and is
     * shared by every player in the same Sonos system.
     */
    async getHouseholdID(): Promise<string | null> {
        const body = RequestBuilder.buildSimpleBody({});
        const response = await this.callAction('GetHouseholdID', body);

        if (!response.success || !response.body) {
            return null;
        }

        const value = XmlParser.extractValue(response.body, 'CurrentHouseholdID');
        return value ? value.trim() : null;
    }
}
