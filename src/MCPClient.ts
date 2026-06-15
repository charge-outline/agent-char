import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {type Tool } from "@modelcontextprotocol/sdk/types.js";

//1个mcp server对应1个MCPClient实例，MCPClient负责与MCP服务器通信，获取工具列表，并提供调用工具的接口。
//transport(传输层)是指MCPClient与MCP服务器通信的方式，这里使用stdio，即通过标准输入输出流进行通信。MCPClient会启动一个子进程运行MCP服务器，并通过stdio与其通信。
export default class MCPClient {
    private mcp: Client;
    private name: string;
    private command: string;
    private args: string[]
    private transport: StdioClientTransport | null = null;
    private tools: Tool[] = [];

    constructor(name: string, command: string, args: string[], version?: string) {
        this.name = name;
        this.mcp = new Client({ name, version: version || "0.0.1" });
        this.command = command;
        this.args = args;
    }

    public async init() {
        await this.connectToServer();
    }

    public async close() {
        await this.mcp.close();
    }

    public getTools() {
        return this.tools;
    }

    public getName() {
        return this.name;
    }

    public callTool(name: string, params: Record<string, any>) {
        return this.mcp.callTool({
            name,
            arguments: params,
        });
    }

    private async connectToServer() {
        try {
            this.transport = new StdioClientTransport({
                command: this.command,
                args: this.args,
            });
            await this.mcp.connect(this.transport);

            const toolsResult = await this.mcp.listTools();
            this.tools = toolsResult.tools.map((tool) => {
                return {
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                };
            });
            console.log(
                "Connected to server with tools:",
                this.tools.map(({ name }) => name)
            );
        } catch (e) {
            console.log("Failed to connect to MCP server: ", e);
            throw e;
        }
    }
}
