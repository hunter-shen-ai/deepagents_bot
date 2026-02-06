import { MultiServerMCPClient, type ClientConfig } from '@langchain/mcp-adapters';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { Config, MCPConfig, MCPServerConfig } from './config.js';

type MCPBootstrapResult = {
    tools: DynamicStructuredTool[];
    close: () => Promise<void>;
    serverNames: string[];
};

function getServerConnectionConfig(serverName: string, server: MCPServerConfig): Record<string, unknown> {
    if (server.transport === 'stdio') {
        if (!server.command?.trim()) {
            throw new Error(`[MCP] Server "${serverName}" is stdio but "command" is empty`);
        }

        return {
            transport: 'stdio',
            command: server.command,
            args: server.args ?? [],
            env: server.env,
            cwd: server.cwd,
            stderr: server.stderr,
            restart: server.restart,
            defaultToolTimeout: server.defaultToolTimeout,
            outputHandling: server.outputHandling,
        };
    }

    if (!server.url?.trim()) {
        throw new Error(`[MCP] Server "${serverName}" is ${server.transport} but "url" is empty`);
    }

    return {
        transport: server.transport,
        url: server.url,
        headers: server.headers,
        reconnect: server.reconnect,
        automaticSSEFallback: server.automaticSSEFallback,
        defaultToolTimeout: server.defaultToolTimeout,
        outputHandling: server.outputHandling,
    };
}

function getMCPClientConfig(mcpConfig: MCPConfig): ClientConfig {
    const mcpServers: Record<string, Record<string, unknown>> = {};

    for (const [serverName, server] of Object.entries(mcpConfig.servers || {})) {
        if (!serverName.trim()) {
            continue;
        }
        mcpServers[serverName] = getServerConnectionConfig(serverName, server);
    }

    return {
        mcpServers: mcpServers as ClientConfig['mcpServers'],
        throwOnLoadError: mcpConfig.throwOnLoadError ?? true,
        prefixToolNameWithServerName: mcpConfig.prefixToolNameWithServerName ?? true,
        additionalToolNamePrefix: mcpConfig.additionalToolNamePrefix ?? '',
        useStandardContentBlocks: mcpConfig.useStandardContentBlocks ?? false,
        onConnectionError: mcpConfig.onConnectionError ?? 'throw',
    };
}

export async function initializeMCPTools(config: Config): Promise<MCPBootstrapResult> {
    if (!config.mcp?.enabled) {
        return {
            tools: [],
            close: async () => { /* no-op */ },
            serverNames: [],
        };
    }

    const serverNames = Object.keys(config.mcp.servers || {});
    if (serverNames.length === 0) {
        console.warn('[MCP] mcp.enabled=true but no servers configured, skipping MCP initialization.');
        return {
            tools: [],
            close: async () => { /* no-op */ },
            serverNames: [],
        };
    }

    const clientConfig = getMCPClientConfig(config.mcp);
    const client = new MultiServerMCPClient(clientConfig);

    try {
        const tools = await client.getTools();
        console.log(`[MCP] Loaded ${tools.length} tool(s) from ${serverNames.length} server(s).`);
        return {
            tools,
            close: async () => {
                await client.close();
            },
            serverNames,
        };
    } catch (error) {
        try {
            await client.close();
        } catch {
            // Ignore close failures while bubbling up init error.
        }
        throw error;
    }
}

