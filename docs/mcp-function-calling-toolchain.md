# MCP + Function Calling Toolchain

## 1. Goal

This project now supports two assistant modes:

- `chat`: normal upstream model response, no主动工具调用
- `agent`: model-side Function Calling + MCP tool execution + tool result refill + final answer streaming

The core purpose is to let the model:

1. decide whether tools are needed
2. choose the right MCP tool
3. execute the tool on the server side
4. feed the result back into the model context
5. stream the final answer and execution trace to the frontend

---

## 2. High-level Architecture

The current implementation is split into four layers:

1. Frontend chat UI
2. Express API + SSE streaming layer
3. Agent orchestration layer
4. MCP client layer

Key files:

- Frontend page: [apps/web/src/views/ChatView.vue](E:/coder/react/llm-rag-try/apps/web/src/views/ChatView.vue)
- Frontend API wrapper: [apps/web/src/lib/api.ts](E:/coder/react/llm-rag-try/apps/web/src/lib/api.ts)
- Shared frontend event types: [apps/web/src/types.ts](E:/coder/react/llm-rag-try/apps/web/src/types.ts)
- Chat route: [apps/server/src/index.ts](E:/coder/react/llm-rag-try/apps/server/src/index.ts)
- Agent streaming loop: [apps/server/src/streaming.ts](E:/coder/react/llm-rag-try/apps/server/src/streaming.ts)
- MCP manager: [apps/server/src/mcp.ts](E:/coder/react/llm-rag-try/apps/server/src/mcp.ts)
- Server config: [apps/server/src/config.ts](E:/coder/react/llm-rag-try/apps/server/src/config.ts)
- Shared server event types: [apps/server/src/types.ts](E:/coder/react/llm-rag-try/apps/server/src/types.ts)

---

## 3. Request Flow

When the user clicks `Send`, the frontend sends a `POST /api/chat` request.

Current request shape:

```json
{
  "conversationId": 12,
  "message": "请读取这个项目目录里和 SSE、streaming、MCP 相关的代码",
  "history": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "mode": "buffered",
  "provider": "live",
  "assistantMode": "agent"
}
```

Important fields:

- `provider`
  - `mock`: local mock stream
  - `live`: real upstream model
- `assistantMode`
  - `chat`: no Function Calling
  - `agent`: enable Function Calling + MCP tools

The route entry is in [apps/server/src/index.ts](E:/coder/react/llm-rag-try/apps/server/src/index.ts).

The server writes an SSE `start` event first, then calls `streamByProvider(...)`.

---

## 4. SSE Event Flow

The backend streams multiple SSE event types:

- `start`
- `token`
- `agent_event`
- `done`
- `error`

Server event definitions live in [apps/server/src/types.ts](E:/coder/react/llm-rag-try/apps/server/src/types.ts).

Frontend parsing lives in:

- [apps/web/src/lib/readSse.ts](E:/coder/react/llm-rag-try/apps/web/src/lib/readSse.ts)
- [apps/web/src/views/ChatView.vue](E:/coder/react/llm-rag-try/apps/web/src/views/ChatView.vue)

### `start`

Sent once per request:

```json
{
  "type": "start",
  "mode": "buffered",
  "model": "qwen-plus",
  "provider": "live",
  "conversationId": 12,
  "assistantMode": "agent"
}
```

### `token`

Used for incremental final-answer rendering:

```json
{
  "type": "token",
  "content": "你"
}
```

### `agent_event`

Used for visualization of internal tool workflow:

```json
{
  "type": "agent_event",
  "level": "running",
  "stage": "tool_call",
  "title": "Calling read_text_file",
  "detail": "{\"path\":\"E:/coder/react/llm-rag-try/apps/server/src/streaming.ts\"}",
  "toolName": "read_text_file"
}
```

Current stages:

- `bootstrap`
- `thinking`
- `tool_call`
- `tool_result`
- `final`

### `done`

Signals the answer is complete.

### `error`

Typed error payload:

```json
{
  "type": "error",
  "code": "server_error",
  "message": "..."
}
```

---

## 5. How Function Calling Works Here

The Agent flow is implemented in [apps/server/src/streaming.ts](E:/coder/react/llm-rag-try/apps/server/src/streaming.ts).

The entry function is:

- `streamByProvider(...)`

Decision tree:

1. `provider === "mock"` -> use mock token stream
2. `assistantMode === "agent"` -> use agent loop
3. otherwise -> use plain live model stream

The actual agent branch is:

- `streamAgentTokens(...)`

### Core loop

The loop roughly does this:

1. load available MCP tools from `MCPManager`
2. convert MCP tools to OpenAI-compatible `tools`
3. build `messages`
4. call `client.chat.completions.create(...)` with:
   - `stream: false`
   - `tools`
   - `tool_choice: "auto"`
5. inspect the assistant message
6. if there are no tool calls:
   - stream final text back to the frontend
7. if there are tool calls:
   - execute them one by one
   - append each tool result back into `messages`
   - continue the loop

Pseudo-flow:

```ts
while (turn < MAX_AGENT_TURNS) {
  const completion = await client.chat.completions.create({
    model,
    stream: false,
    messages,
    tools,
    tool_choice: "auto",
  });

  const assistantMessage = completion.choices[0]?.message;
  const toolCalls = assistantMessage.tool_calls ?? [];

  messages.push(assistantMessage);

  if (toolCalls.length === 0) {
    stream final answer;
    return;
  }

  for (toolCall of toolCalls) {
    const result = await manager.callTool(...);
    messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: serializedResult,
    });
  }
}
```

---

## 6. How MCP Tools Are Registered

MCP tool management is centralized in [apps/server/src/mcp.ts](E:/coder/react/llm-rag-try/apps/server/src/mcp.ts).

### Current default servers

If `MCP_SERVERS_JSON` is not provided, the system currently registers:

1. `filesystem`
2. `fetch`

Default config:

```ts
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
```

### MCPManager responsibilities

`MCPManager` does four things:

1. start each MCP server via stdio
2. call `listTools()` and cache tool metadata
3. expose `getToolSummaries()` to the rest of the app
4. route `callTool(name, args)` to the correct MCP client

### Partial failure behavior

The manager is intentionally tolerant:

- if one MCP server fails to start, others can still work
- startup errors are aggregated into `initError`
- frontend can display available tools plus failures separately

This is why `fetch` failing will not kill `filesystem`.

---

## 7. Filesystem MCP Scope Restriction

This is the part you explicitly asked for.

### Old idea in legacy agent

Your old agent used:

- [src/index.ts](E:/coder/react/llm-rag-try/src/index.ts)

It had:

```ts
const curreDntDir = process.cwd();
const fileMCPClient = new MCPClient(
  "file",
  "npx",
  ["-y", "@modelcontextprotocol/server-filesystem", curreDntDir]
);
```

The important idea there was:

- use the current project directory as the only allowed directory

### Current implementation

Now this idea is made explicit and stable in:

- [apps/server/src/config.ts](E:/coder/react/llm-rag-try/apps/server/src/config.ts)

The server now computes `workspaceRoot` from the file location itself, not from the launch cwd:

```ts
const currentFileDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(currentFileDir, "../../..");
```

This means `filesystem MCP` is restricted to:

- `E:/coder/react/llm-rag-try`

instead of depending on whether the server was launched from:

- repo root
- `apps/server`
- another parent directory

This removes cwd drift and keeps the allowed directory aligned with the current project.

---

## 8. How Tool Execution Is Visualized

The backend sends `agent_event` packets during each major step.

Examples:

- `MCP tools ready`
- `Model reasoning`
- `Calling read_text_file`
- `Tool read_text_file completed`
- `Final answer ready`

The frontend stores these logs in:

- `agentLogs`

and renders them in:

- [apps/web/src/views/ChatView.vue](E:/coder/react/llm-rag-try/apps/web/src/views/ChatView.vue)

Current UI behavior:

- tool trace is mixed into the main feed
- each step is rendered as a collapsible execution card
- final user-facing answer still renders as streamed assistant text

So the visible chain is:

1. user asks question
2. agent trace appears
3. MCP tool calls are listed
4. final answer streams after tool execution converges

---

## 9. Why the Agent Previously Looped

You hit a real issue earlier:

- the model could repeatedly call the same tool
- for example repeated `list_allowed_directories`
- eventually the loop hit `MAX_AGENT_TURNS`
- the UI showed a server error-like terminal state

### Current mitigations

These were added in [apps/server/src/streaming.ts](E:/coder/react/llm-rag-try/apps/server/src/streaming.ts):

1. stronger system rules
   - do not repeat identical tool calls
   - stop once enough evidence is gathered
2. duplicate tool-call suppression
   - same `tool + identical arguments` is limited
3. forced final summarization
   - when max turns are reached, the model is instructed to stop using tools and summarize using current evidence

So now the chain is more robust:

- fewer loops
- better convergence
- less chance of ending in a raw error response

---

## 10. Current Limits

This implementation is already usable, but still has clear limits.

### Not yet production-hard

Reasons:

1. tool planning is still model-driven, not graph-driven
2. tool selection is broad; there is no task-specific tool subset yet
3. no per-tool timeout / cancellation wrapper yet
4. no per-tool latency reporting yet
5. no persistent execution record in database yet
6. `fetch` still uses `uvx`, which is convenient for dev but not ideal for production

### Practical consequence

For code-reading and project-inspection tasks it works well enough.

For long workflows or multi-step autonomous tasks, you would still want:

- planner
- timeout policy
- retries
- structured tool result normalization
- stricter production MCP deployment model

---

## 11. Recommended Next Improvements

If we continue this system, the best next steps are:

1. add a task-specific planner
   - code-analysis tasks should prefer:
     - `search_files`
     - `read_text_file`
     - `read_multiple_files`
2. add per-tool timeout and explicit tool duration metrics
3. persist agent trace into MySQL
4. split dev vs prod MCP server boot strategy
5. optionally register only the tools needed for the current task

---

## 12. Quick Summary

In one sentence:

This project uses OpenAI-compatible Function Calling on the backend to let the model choose MCP tools, executes those tools through stdio-based MCP clients, feeds tool results back into the model conversation, and streams both execution trace and final answer to the frontend over SSE.

And for the filesystem scope:

The `filesystem MCP` is now explicitly restricted to the current repo root:

- `E:/coder/react/llm-rag-try`

which is the stable equivalent of the old `current_dir` idea from your legacy agent.
