import MCPClient from "./MCPClient.js";
import ChatOpenAI from "./ChatOpneAI.js";
import { logTitle } from "./utils.js";

export default class Agent {
    private mcpClient: MCPClient[];
    private llm: ChatOpenAI | null = null;
    private model: string;
    private systemPrompt: string;
    private context: string;

    constructor(model: string, systemPrompt: string = "", context: string = "", mcpClient: MCPClient[]) {
        this.model = model;
        this.systemPrompt = systemPrompt;
        this.context = context;
        this.mcpClient = mcpClient;
    }

    public async init() {
        logTitle("开始初始化Agent");

        for (const client of this.mcpClient) {
            await client.init();
        }

        const tools = this.mcpClient.flatMap((client) => client.getTools());
        this.llm = new ChatOpenAI(this.model, this.systemPrompt, tools, this.context);
        logTitle("Agent初始化完成");
    }

    public async close() {
        for (const client of this.mcpClient) {
            await client.close();
        }
    }

    async invoke(prompt: string) {
        if (!this.llm) {
            throw new Error("Agent未初始化");
        }

        let response = await this.llm.chat(prompt);

        while (true) {
            if (response.toolCalls.length === 0) {
                await this.close();
                return response.content;
            }

            for (const toolCall of response.toolCalls) {
                const mcpClient = this.mcpClient.find((client) =>
                    client.getTools().some((tool) => tool.name === toolCall.function.name),
                );

                if (!mcpClient) {
                    console.log(`没有找到工具 ${toolCall.function.name} 对应的MCPClient`);
                    continue;
                }

                logTitle(`调用工具 ${toolCall.function.name}，参数：${toolCall.function.arguments}`);
                const result = await mcpClient.callTool(
                    toolCall.function.name,
                    JSON.parse(toolCall.function.arguments),
                );
                logTitle(`工具 ${toolCall.function.name} 调用结果`);
                console.log(result);

                this.llm.appendToolResult(toolCall.id, JSON.stringify(result));
            }

            response = await this.llm.chat();
        }
    }
}
