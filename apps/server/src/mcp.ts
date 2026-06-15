import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";

type MCPServerConfig = {
    name: string;
    command: string;
    args: string[];
};

type MCPCallResult = unknown;

class MCPClient {
    private readonly client: Client;
    private transport: StdioClientTransport | null = null;
    private tools: Tool[] = [];

    constructor(private readonly server: MCPServerConfig) {
        this.client = new Client({
            name: server.name,
            version: "0.1.0",
        });
    }

    async init() {
        if (this.transport) {
            return;
        }

        this.transport = new StdioClientTransport({
            command: this.server.command,
            args: this.server.args,
        });

        await this.client.connect(this.transport);
        const toolsResult = await this.client.listTools();
        this.tools = toolsResult.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        }));
    }

    async close() {
        await this.client.close();
        this.transport = null;
    }

    getName() {
        return this.server.name;
    }

    getTools() {
        return this.tools;
    }

    async callTool(name: string, args: Record<string, unknown>) {
        return this.client.callTool({
            name,
            arguments: args,
        }) as Promise<MCPCallResult>;
    }
}

class MCPManager {
    private clients: MCPClient[] = [];
    private initialized = false;
    private initError: string | null = null;

    async init() {
        if (this.initialized) {
            return;
        }

        const servers = resolveServerConfigs();
        if (servers.length === 0) {
            this.initialized = true;
            return;
        }

        const readyClients: MCPClient[] = [];
        const errors: string[] = [];

        for (const server of servers) {
            const client = new MCPClient(server);
            try {
                await client.init();
                readyClients.push(client);
            } catch (error) {
                errors.push(
                    `${server.name}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        this.clients = readyClients;
        this.initialized = true;
        this.initError = errors.length > 0 ? errors.join(" | ") : null;
    }

    async ensureReady() {
        if (!this.initialized) {
            await this.init();
        }
    }

    getStatus() {
        return {
            ready: this.initialized,
            error: this.initError,
            tools: this.getToolSummaries(),
        };
    }

    getToolSummaries() {
        return this.clients.flatMap((client) =>
            client.getTools().map((tool) => ({
                serverName: client.getName(),
                name: tool.name,
                description: tool.description ?? "",
                inputSchema: tool.inputSchema,
            })),
        );
    }

    async callTool(name: string, args: Record<string, unknown>) {
        const client = this.clients.find((item) =>
            item.getTools().some((tool) => tool.name === name),
        );

        if (!client) {
            throw new Error(`Tool ${name} is not registered in current MCP clients.`);
        }

        return client.callTool(name, args);
    }
}

let managerPromise: Promise<MCPManager> | null = null;

function resolveServerConfigs(): MCPServerConfig[] {
    if (config.mcp.serversJson.trim()) {
        try {
            const parsed = JSON.parse(config.mcp.serversJson) as MCPServerConfig[];
            return Array.isArray(parsed)
                ? parsed.filter(
                      (item) =>
                          !!item &&
                          typeof item.name === "string" &&
                          typeof item.command === "string" &&
                          Array.isArray(item.args),
                  )
                : [];
        } catch {
            return [];
        }
    }

    return [
        {
            name: "filesystem",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", config.workspaceRoot],
        },
        {
            name: "fetch",
            command: "uvx",
            args: ["mcp-server-fetch"],
        },
    ];
}

export async function getMCPManager() {
    if (!managerPromise) {
        managerPromise = (async () => {
            const manager = new MCPManager();
            await manager.init();
            return manager;
        })();
    }

    return managerPromise;
}
