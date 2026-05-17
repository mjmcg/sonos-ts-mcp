import type { ServerContext, ToolResponse } from '../types/handler-types.js';
import { MusicServiceRegistry } from '../../discovery/music-service-registry.js';
import { SmapiAuthFlow } from '../../services/smapi/auth-flow.js';
import { resolveSmapiContext } from '../../services/smapi/auth-context.js';
import { getTokenStore } from '../../services/smapi/token-store.js';

/**
 * SMAPI authentication MCP handlers.
 *
 * These tools are intended for human-driven setup, not agent-initiated
 * use. The flow is two-step (begin → user does partner site → complete)
 * and the only way it makes sense for an agent to "automate" it is to
 * surface the URL/code to the user. The agent prompt does NOT teach
 * these tools — they're exposed for direct invocation via Claude Desktop
 * or MCP Inspector during initial setup.
 */

// Registry cache — shares with the music-service-handlers cache when
// possible; we look it up by deviceId.
const registries = new Map<string, MusicServiceRegistry>();
function getRegistry(context: ServerContext, deviceId: string): MusicServiceRegistry {
    if (!registries.has(deviceId)) {
        const device = context.resolver.resolve(deviceId);
        registries.set(deviceId, new MusicServiceRegistry(device));
    }
    return registries.get(deviceId)!;
}

function errorResponse(message: string, extra?: Record<string, unknown>): ToolResponse {
    return {
        content: [{
            type: 'text',
            text: JSON.stringify({ error: message, ...(extra ?? {}) }),
        }],
        isError: true,
    };
}

function okResponse(body: Record<string, unknown>): ToolResponse {
    return {
        content: [{ type: 'text', text: JSON.stringify(body) }],
    };
}

/**
 * Handle sonos_smapi_auth_begin
 */
export async function handleSmapiAuthBegin(args: unknown, context: ServerContext): Promise<ToolResponse> {
    const { deviceId, serviceName } = args as { deviceId: string; serviceName: string };
    if (!deviceId || !serviceName) {
        return errorResponse('deviceId and serviceName are required');
    }

    try {
        const device = context.resolver.resolve(deviceId);
        const registry = getRegistry(context, deviceId);
        const service = await registry.getServiceByName(serviceName);
        if (!service) {
            return errorResponse(
                `Music service "${serviceName}" not found. Run sonos_list_music_services to see available service names.`
            );
        }
        if (service.authType === 'Anonymous') {
            return errorResponse(
                `${service.name} is Anonymous and does not require authentication.`,
                { authType: service.authType }
            );
        }

        const flow = new SmapiAuthFlow(device, service);
        const result = await flow.begin();
        return okResponse({
            serviceId: service.id,
            serviceName: service.name,
            authType: service.authType,
            ...result,
            nextStep:
                'After completing the partner-site flow, call sonos_smapi_auth_complete ' +
                'with the same deviceId, serviceName, and linkCode.',
        });
    } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
    }
}

/**
 * Handle sonos_smapi_auth_complete
 */
export async function handleSmapiAuthComplete(args: unknown, context: ServerContext): Promise<ToolResponse> {
    const { deviceId, serviceName, linkCode, linkDeviceId } = args as {
        deviceId: string;
        serviceName: string;
        linkCode: string;
        linkDeviceId?: string;
    };
    if (!deviceId || !serviceName || !linkCode) {
        return errorResponse('deviceId, serviceName, and linkCode are required');
    }

    try {
        const device = context.resolver.resolve(deviceId);
        const registry = getRegistry(context, deviceId);
        const service = await registry.getServiceByName(serviceName);
        if (!service) {
            return errorResponse(`Music service "${serviceName}" not found.`);
        }

        const flow = new SmapiAuthFlow(device, service);
        const result = await flow.complete(linkCode, linkDeviceId);
        return okResponse({
            status: 'linked',
            ...result,
            hint: `Now try sonos_browse_music_service with serviceName="${service.name}" to confirm.`,
        });
    } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
    }
}

/**
 * Handle sonos_smapi_auth_status
 */
export async function handleSmapiAuthStatus(args: unknown, context: ServerContext): Promise<ToolResponse> {
    const { deviceId } = args as { deviceId: string };
    if (!deviceId) {
        return errorResponse('deviceId is required');
    }
    try {
        const device = context.resolver.resolve(deviceId);
        const registry = getRegistry(context, deviceId);
        const [{ householdId }, services] = await Promise.all([
            resolveSmapiContext(device),
            registry.discoverServices(),
        ]);
        const stored = await getTokenStore().list(householdId);
        const storedById = new Map(stored.map(s => [s.serviceId, s] as const));

        const summary = services.map(svc => ({
            id: svc.id,
            name: svc.name,
            authType: svc.authType,
            requiresLink: svc.authType === 'DeviceLink' || svc.authType === 'AppLink',
            linked: storedById.has(svc.id),
            linkedAt: storedById.get(svc.id)?.updatedAt,
        }));

        return okResponse({
            householdId,
            linkedCount: stored.length,
            services: summary,
        });
    } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
    }
}

/**
 * Handle sonos_smapi_auth_remove
 */
export async function handleSmapiAuthRemove(args: unknown, context: ServerContext): Promise<ToolResponse> {
    const { deviceId, serviceName } = args as { deviceId: string; serviceName: string };
    if (!deviceId || !serviceName) {
        return errorResponse('deviceId and serviceName are required');
    }
    try {
        const device = context.resolver.resolve(deviceId);
        const registry = getRegistry(context, deviceId);
        const service = await registry.getServiceByName(serviceName);
        if (!service) {
            return errorResponse(`Music service "${serviceName}" not found.`);
        }
        const { householdId } = await resolveSmapiContext(device);
        const removed = await getTokenStore().delete(service.id, householdId);
        return okResponse({
            status: removed ? 'removed' : 'not-linked',
            serviceId: service.id,
            serviceName: service.name,
            householdId,
        });
    } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
    }
}
