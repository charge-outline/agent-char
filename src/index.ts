import Agent  from "./Agent.js";
import ChatOpenAI from "./ChatOpneAI.js";
import MCPClient from "./MCPClient.js";
import EmbeddingRetriver from "./EmbeddingRetrivers.js";
import path from "path";
import fs from "fs";
    // const chat = new ChatOpenAI("qwen-plus");
    // const {content,toolCalls} = await chat.chat("你好");
    // console.log("Final Response:", content);
    // console.log("Tool Calls:", toolCalls);

const curreDntDir= process.cwd();

const fetchMCP = new MCPClient("fetch", "uvx", ["mcp-server-fetch"]);
const fileMCPClient = new MCPClient("file", "npx", ["-y","@modelcontextprotocol/server-filesystem", curreDntDir]);
    
async function main() { 
    const prompt = `根据Bert的简介,创建一个200字的修仙小说的故事,保存到${curreDntDir}/story/bert.md,要包含他的基本信息和故事`;
    const context = await retrieveContext(prompt);
    const agnet = new Agent("qwen-plus", '', context, [fetchMCP, fileMCPClient]);
    await agnet.init();
    const response = await agnet.invoke(prompt)
    console.log(response);
    await agnet.close();
}

async function retrieveContext(prompt: string) {
    //rag
    const embeddingRetriver = new EmbeddingRetriver("BAAI/bge-m3");
    const konwledgeDir = path.join(curreDntDir, "knowledge");
    const files = fs.readdirSync(konwledgeDir);
    
    for (const file of files) {
        const filePath = path.join(konwledgeDir, file);
        const content = fs.readFileSync(filePath, "utf-8");
        const embedding = await embeddingRetriver.embedDocuments(content);
        console.log(`File: ${file}, Embedding: ${embedding}`);
    }
    const context = await embeddingRetriver.retrive(prompt);
    console.log(`Context: ${context}`); 
    return context.map(item => item.document).join("\n");
}

main();