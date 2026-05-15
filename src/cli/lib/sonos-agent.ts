import { Agent } from '@mastra/core/agent';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { SONOS_AGENT_INSTRUCTIONS } from '../../mcp/constants.js';

export interface SonosAgentConfig {
    tools: Record<string, unknown>;
    model?: string;
}

export function createSonosAgent(config: SonosAgentConfig): Agent {
    const modelName = config.model || 'gpt-4o-mini';

    // openai.chat() forces the Chat Completions endpoint instead of the
    // newer Responses API (which is the default of openai()). Many providers
    // routed via OpenAI-compatible proxies (LiteLLM → GitHub Copilot, etc.)
    // don't implement /v1/responses, but every provider implements
    // /v1/chat/completions.
    const model = modelName.startsWith('gemini')
        ? google(modelName)
        : openai.chat(modelName);

    return new Agent({
        id: 'sonos-control-agent',
        name: 'Sonos Control Agent',
        description: 'An AI agent specialized in controlling Sonos multi-room audio systems.',
        instructions: SONOS_AGENT_INSTRUCTIONS,
        model: model,
        tools: config.tools,
    });
}

export const SONOS_AGENT_DEFAULT_MODEL = 'gpt-4o-mini';
