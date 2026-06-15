<script setup lang="ts">
import DOMPurify from "dompurify";
import { computed, nextTick, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { DynamicScroller, DynamicScrollerItem } from "vue-virtual-scroller";
import "./ChatView.css";
import {
    deleteConversation,
    fetchBootstrap,
    fetchConversationDetail,
    fetchConversations,
    logout,
    openChatStream,
    type AgentToolSummary,
    type ConversationSummary,
    type PersistedMessage,
} from "../lib/api";
import { useAuthState } from "../lib/auth";
import { readSSE } from "../lib/readSse";
import type {
    AgentEventPayload,
    AssistantMode,
    ErrorCode,
    MemoryMessage,
    Provider,
    RenderMode,
    SSEPayload,
} from "../types";

type ChatMessage = {
    id: number;
    role: "user" | "assistant";
    content: string;
    streaming: boolean;
    status: "complete" | "streaming" | "cancelled" | "error";
};

type ChatStatus =
    | "idle"
    | "loading"
    | "streaming"
    | "complete"
    | "cancelled"
    | "upstream_error"
    | "server_error"
    | "network_error";

type RequestSnapshot = {
    conversationId: number | null;
    history: MemoryMessage[];
    message: string;
    mode: RenderMode;
    provider: Provider;
    assistantMode: AssistantMode;
};

type AgentLogEntry = AgentEventPayload & {
    id: number;
};

type FeedRow =
    | {
          id: string;
          kind: "message";
          message: ChatMessage;
      }
    | {
          id: string;
          kind: "trace";
      };

const BUFFER_FLUSH_THRESHOLD = 24;

const auth = useAuthState();
const router = useRouter();

const prompt = ref(
    "请读取这个项目目录里和 SSE、streaming、MCP 相关的代码，并告诉我现在工具调用链路缺了什么。",
);
const mode = ref<RenderMode>("buffered");
const provider = ref<Provider>("live");
const assistantMode = ref<AssistantMode>("nba");
const status = ref<ChatStatus>("loading");
const messages = ref<ChatMessage[]>([]);
const conversations = ref<ConversationSummary[]>([]);
const agentTools = ref<AgentToolSummary[]>([]);
const agentError = ref<string | null>(null);
const agentLogs = ref<AgentLogEntry[]>([]);
const commitCount = ref(0);
const tokenCount = ref(0);
const activeModel = ref("qwen-plus");
const activeProvider = ref<Provider>("live");
const abortController = ref<AbortController | null>(null);
const scrollerRef = ref<{ $el?: HTMLElement } | null>(null);
const userScrolledUp = ref(false);
const nextMessageId = ref(1);
const nextLogId = ref(1);
const lastRequest = ref<RequestSnapshot | null>(null);
const conversationId = ref<number | null>(null);
const currentConversationTitle = ref("New conversation");
const sidebarLoading = ref(false);
const sidebarCollapsed = ref(false);
const inspectorOpen = ref(false);

const hasMessages = computed(() => messages.value.length > 0);
const hasActiveConversation = computed(() => conversationId.value !== null);
const hasAgentTools = computed(() => agentTools.value.length > 0);
const activeConversation = computed(() =>
    conversations.value.find((item) => item.id === conversationId.value) ?? null,
);
const canRetry = computed(
    () =>
        !!lastRequest.value &&
        (status.value === "network_error" ||
            status.value === "upstream_error" ||
            status.value === "server_error"),
);
const providerSummary = computed(() => {
    if (activeProvider.value === "mock") {
        return "Burst mock stream for render stress testing";
    }

    if (assistantMode.value === "agent") {
        return "Planner -> MCP tools -> result refill -> final answer";
    }

    if (assistantMode.value === "nba") {
        return "Hybrid NBA retrieval -> Chroma + BM25 -> grounded answer streaming";
    }

    return "Live upstream model with direct answer streaming";
});

const statusLabel = computed(() => {
    switch (status.value) {
        case "cancelled":
            return "cancelled";
        case "upstream_error":
            return "upstream error";
        case "server_error":
            return "server error";
        case "network_error":
            return "network error";
        default:
            return status.value;
    }
});

const latestAssistantIndex = computed(() => {
    for (let index = messages.value.length - 1; index >= 0; index -= 1) {
        if (messages.value[index]?.role === "assistant") {
            return index;
        }
    }

    return -1;
});

const feedRows = computed<FeedRow[]>(() => {
    const traceIndex = latestAssistantIndex.value;
    const rows: FeedRow[] = [];

    messages.value.forEach((message, index) => {
        if (agentLogs.value.length > 0 && index === traceIndex) {
            rows.push({
                id: "trace-row",
                kind: "trace",
            });
        }

        rows.push({
            id: `message-${message.id}`,
            kind: "message",
            message,
        });
    });

    if (rows.length === 0 && agentLogs.value.length > 0) {
        rows.push({
            id: "trace-row",
            kind: "trace",
        });
    }

    return rows;
});

function sanitizeAssistantContent(content: string) {
    return DOMPurify.sanitize(content.replace(/\n/g, "<br/>"), {
        USE_PROFILES: { html: true },
    });
}

function pushAgentLog(payload: AgentEventPayload) {
    agentLogs.value = [
        ...agentLogs.value,
        {
            id: nextLogId.value,
            ...payload,
        },
    ];
    nextLogId.value += 1;
}

function formatScore(value?: number) {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return "--";
    }

    return value.toFixed(3);
}

function resetAgentLogs() {
    agentLogs.value = [];
}

function truncatePreview(value: string | null, fallback = "No messages yet") {
    const source = (value ?? "").trim();
    if (!source) {
        return fallback;
    }

    return source.length > 54 ? `${source.slice(0, 54)}...` : source;
}

function formatConversationTime(updatedAt: string) {
    const date = new Date(updatedAt);
    return new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
}

function mapPersistedMessages(list: PersistedMessage[]) {
    return list.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        streaming: message.status === "streaming",
        status: message.status,
    })) as ChatMessage[];
}

function applyMessages(nextMessages: ChatMessage[]) {
    messages.value = nextMessages;
    nextMessageId.value =
        nextMessages.reduce((maxId, message) => Math.max(maxId, message.id), 0) + 1;
}

function resetRenderCounters() {
    commitCount.value = 0;
    tokenCount.value = 0;
    userScrolledUp.value = false;
}

function syncMessages(nextMessages: ChatMessage[], forceScroll = false) {
    messages.value = nextMessages.map((message) => ({ ...message }));
    nextTick(() => {
        const scrollerElement = (scrollerRef.value?.$el as HTMLElement | undefined) ?? null;
        if (!scrollerElement) {
            return;
        }

        const distanceFromBottom =
            scrollerElement.scrollHeight - scrollerElement.scrollTop - scrollerElement.clientHeight;
        const shouldStickToBottom = distanceFromBottom <= 96;

        if (!forceScroll && (userScrolledUp.value || !shouldStickToBottom)) {
            return;
        }

        scrollerElement.scrollTop = scrollerElement.scrollHeight;
    });
}

function handleScroll() {
    const scrollerElement = (scrollerRef.value?.$el as HTMLElement | undefined) ?? null;
    if (!scrollerElement) {
        return;
    }

    const distanceFromBottom =
        scrollerElement.scrollHeight - scrollerElement.scrollTop - scrollerElement.clientHeight;
    userScrolledUp.value = distanceFromBottom > 96;
}

function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value;
}

function toggleInspector() {
    inspectorOpen.value = !inspectorOpen.value;
}

async function refreshConversationList() {
    const payload = await fetchConversations();
    conversations.value = payload.conversations;
    if (conversationId.value !== null) {
        currentConversationTitle.value =
            payload.conversations.find((item) => item.id === conversationId.value)?.title ??
            currentConversationTitle.value;
    }
}

function startNewChat() {
    abortController.value?.abort();
    conversationId.value = null;
    currentConversationTitle.value = "New conversation";
    applyMessages([]);
    lastRequest.value = null;
    status.value = "idle";
    resetRenderCounters();
    resetAgentLogs();
}

async function loadConversation(targetConversationId: number) {
    abortController.value?.abort();
    sidebarLoading.value = true;
    status.value = "loading";

    try {
        const payload = await fetchConversationDetail(targetConversationId);
        conversationId.value = payload.conversation.id;
        currentConversationTitle.value = payload.conversation.title;
        applyMessages(mapPersistedMessages(payload.messages));
        lastRequest.value = null;
        status.value = "idle";
        resetRenderCounters();
        resetAgentLogs();
    } finally {
        sidebarLoading.value = false;
    }
}

async function bootstrapChat() {
    status.value = "loading";
    const payload = await fetchBootstrap();
    conversations.value = payload.conversations;
    agentTools.value = payload.agent.availableTools;
    agentError.value = payload.agent.error;
    conversationId.value = payload.conversation?.id ?? null;
    currentConversationTitle.value = payload.conversation?.title ?? "New conversation";
    applyMessages(mapPersistedMessages(payload.messages));
    status.value = "idle";
}

async function resetConversation() {
    if (!conversationId.value) {
        startNewChat();
        return;
    }

    const confirmed = window.confirm("确定删除当前会话吗？这会把该会话的历史消息一起删除。");
    if (!confirmed) {
        return;
    }

    const deletingConversationId = conversationId.value;
    abortController.value?.abort();
    await deleteConversation(deletingConversationId);

    const remainingConversations = conversations.value.filter(
        (item) => item.id !== deletingConversationId,
    );
    conversations.value = remainingConversations;

    const nextConversation = remainingConversations[0];
    if (nextConversation) {
        await loadConversation(nextConversation.id);
        return;
    }

    startNewChat();
}

async function runStreaming(
    request: RequestSnapshot,
    options: { replay?: boolean } = {},
) {
    abortController.value?.abort();

    const controller = new AbortController();
    abortController.value = controller;
    userScrolledUp.value = false;

    status.value = "streaming";
    commitCount.value = 0;
    tokenCount.value = 0;
    lastRequest.value = request;
    resetAgentLogs();

    const baseMessages = options.replay
        ? messages.value
              .filter((message) => !message.streaming)
              .slice(0, -1)
              .map((message) => ({ ...message, streaming: false }))
        : messages.value.map((message) => ({ ...message, streaming: false }));

    const draftMessages = [...baseMessages];

    if (!options.replay) {
        draftMessages.push({
            id: nextMessageId.value,
            role: "user",
            content: request.message,
            streaming: false,
            status: "complete",
        });
        nextMessageId.value += 1;
    }

    const assistantMessage: ChatMessage = {
        id: nextMessageId.value,
        role: "assistant",
        content: "",
        streaming: true,
        status: "streaming",
    };
    nextMessageId.value += 1;

    draftMessages.push(assistantMessage);
    syncMessages(draftMessages, true);

    let receivedTokens = 0;
    let renderedCommits = 0;
    let rafId: number | null = null;
    const tokenBuffer: string[] = [];
    const assistantMessageIndex = draftMessages.length - 1;

    const flushBuffer = () => {
        if (tokenBuffer.length === 0) {
            return;
        }

        const targetMessage = draftMessages[assistantMessageIndex];
        if (!targetMessage) {
            return;
        }

        targetMessage.content += tokenBuffer.join("");
        tokenBuffer.length = 0;
        renderedCommits += 1;

        syncMessages(draftMessages);
        commitCount.value = renderedCommits;
        tokenCount.value = receivedTokens;
    };

    const scheduleFlush = () => {
        if (rafId !== null) {
            return;
        }

        rafId = window.requestAnimationFrame(() => {
            rafId = null;
            flushBuffer();

            if (tokenBuffer.length > 0) {
                scheduleFlush();
            }
        });
    };

    const pushToken = (token: string) => {
        receivedTokens += 1;

        if (mode.value === "direct") {
            const targetMessage = draftMessages[assistantMessageIndex];
            if (!targetMessage) {
                return;
            }

            targetMessage.content += token;
            renderedCommits += 1;
            syncMessages(draftMessages);
            commitCount.value = renderedCommits;
            tokenCount.value = receivedTokens;
            return;
        }

        tokenBuffer.push(token);
        const bufferedCharacters = tokenBuffer.reduce((total, item) => total + item.length, 0);
        if (bufferedCharacters >= BUFFER_FLUSH_THRESHOLD) {
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            flushBuffer();
            return;
        }

        scheduleFlush();
    };

    try {
        const response = await openChatStream(
            {
                conversationId: request.conversationId,
                message: request.message,
                history: request.history,
                mode: request.mode,
                provider: request.provider,
                assistantMode: request.assistantMode,
            },
            controller.signal,
        );

        await readSSE(response, (raw) => {
            if (raw === "[DONE]") {
                return;
            }

            const payload = JSON.parse(raw) as SSEPayload;
            if (payload.type === "start") {
                activeModel.value = payload.model;
                activeProvider.value = payload.provider;
                conversationId.value = payload.conversationId;
                assistantMode.value = payload.assistantMode;
                return;
            }

            if (payload.type === "token") {
                pushToken(payload.content);
                return;
            }

            if (payload.type === "agent_event") {
                pushAgentLog(payload);
                return;
            }

            if (payload.type === "error") {
                const typedError = new Error(payload.message) as Error & { code?: ErrorCode };
                typedError.code = payload.code;
                throw typedError;
            }
        });

        if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }

        flushBuffer();
        const targetMessage = draftMessages[assistantMessageIndex];
        if (targetMessage) {
            targetMessage.streaming = false;
            targetMessage.status = "complete";
        }
        syncMessages(draftMessages);
        status.value = "complete";
    } catch (error) {
        const errorName =
            typeof error === "object" && error && "name" in error ? String(error.name) : "";

        const targetMessage = draftMessages[assistantMessageIndex];
        if (targetMessage) {
            targetMessage.streaming = false;
        }

        if (errorName === "AbortError") {
            if (targetMessage) {
                targetMessage.status = "cancelled";
            }
            syncMessages(draftMessages);
            status.value = "cancelled";
            return;
        }

        const errorCode =
            typeof error === "object" && error && "code" in error ? String(error.code) : "";

        if (errorCode === "upstream_error") {
            status.value = "upstream_error";
        } else if (
            errorCode === "server_error" ||
            errorCode === "validation_error" ||
            errorCode === "unauthorized_error"
        ) {
            status.value = "server_error";
        } else {
            status.value = "network_error";
        }

        if (targetMessage) {
            targetMessage.status = "error";
            targetMessage.content += `${targetMessage.content ? "\n\n" : ""}[${
                status.value === "network_error"
                    ? "network interrupted"
                    : status.value === "upstream_error"
                      ? "upstream error"
                      : "server error"
            }] ${error instanceof Error ? error.message : String(error)}`;
        }
        syncMessages(draftMessages, true);
    } finally {
        if (rafId !== null) {
            cancelAnimationFrame(rafId);
        }

        if (abortController.value === controller) {
            abortController.value = null;
        }

        await refreshConversationList();
    }
}

async function startStreaming() {
    const history: MemoryMessage[] = messages.value
        .filter((item) => item.content.trim().length > 0)
        .map((item) => ({
            role: item.role,
            content: item.content,
        }));

    await runStreaming({
        conversationId: conversationId.value,
        message: prompt.value,
        history,
        mode: mode.value,
        provider: provider.value,
        assistantMode: assistantMode.value,
    });
}

async function retryLastRequest() {
    if (!lastRequest.value) {
        return;
    }

    await runStreaming(lastRequest.value, { replay: true });
}

function stopStreaming() {
    abortController.value?.abort();
}

async function handleLogout() {
    await logout();
    await router.push("/");
}

onMounted(async () => {
    await bootstrapChat();
});
</script>

<template>
  <main class="chat-shell" :class="{ 'chat-shell--collapsed': sidebarCollapsed }">
    <aside class="chat-sidebar">
      <div class="sidebar-header">
        <button class="rail-button" type="button" @click="toggleSidebar">
          {{ sidebarCollapsed ? ">" : "<" }}
        </button>
        <template v-if="!sidebarCollapsed">
          <div class="sidebar-brand">
            <span class="sidebar-kicker">Conversations</span>
            <strong>Agent Char</strong>
          </div>
          <button class="sidebar-new" type="button" @click="startNewChat">New Chat</button>
        </template>
      </div>

      <div v-if="!sidebarCollapsed" class="sidebar-body">
        <button
          class="session-card session-card--draft"
          :class="{ 'session-card--active': !hasActiveConversation }"
          type="button"
          @click="startNewChat"
        >
          <strong>New conversation</strong>
          <span>先在这里起草，第一条消息发出后才会创建真实会话。</span>
        </button>

        <div class="session-stack">
          <button
            v-for="item in conversations"
            :key="item.id"
            class="session-card"
            :class="{ 'session-card--active': item.id === conversationId }"
            type="button"
            @click="loadConversation(item.id)"
          >
            <div class="session-card__top">
              <strong>{{ item.title }}</strong>
              <span>{{ formatConversationTime(item.updatedAt) }}</span>
            </div>
            <p>{{ truncatePreview(item.lastMessage) }}</p>
          </button>
        </div>
      </div>

      <div v-else class="sidebar-mini">
        <button
          class="mini-dot"
          :class="{ 'mini-dot--active': !hasActiveConversation }"
          type="button"
          @click="startNewChat"
        >
          +
        </button>
        <button
          v-for="item in conversations"
          :key="`mini-${item.id}`"
          class="mini-dot"
          :class="{ 'mini-dot--active': item.id === conversationId }"
          type="button"
          @click="loadConversation(item.id)"
        >
          {{ item.title.slice(0, 1) }}
        </button>
      </div>
    </aside>

    <section class="chat-stage">
      <header class="stage-header">
        <div class="stage-heading">
          <span class="stage-kicker">Workspace</span>
          <h1>{{ activeConversation?.title ?? currentConversationTitle }}</h1>
          <p>{{ providerSummary }}</p>
        </div>

        <div class="stage-utility">
          <div class="segmented">
            <button
              type="button"
              class="segmented__item"
              :class="{ 'segmented__item--active': assistantMode === 'chat' }"
              @click="assistantMode = 'chat'"
            >
              Chat
            </button>
            <button
              type="button"
              class="segmented__item"
              :class="{ 'segmented__item--active': assistantMode === 'agent' }"
              :disabled="provider === 'mock'"
              @click="assistantMode = 'agent'"
            >
              Tool Agent
            </button>
            <button
              type="button"
              class="segmented__item"
              :class="{ 'segmented__item--active': assistantMode === 'nba' }"
              :disabled="provider === 'mock'"
              @click="assistantMode = 'nba'"
            >
              NBA Assistant
            </button>
          </div>

          <div class="segmented">
            <button
              type="button"
              class="segmented__item"
              :class="{ 'segmented__item--active': provider === 'live' }"
              @click="provider = 'live'"
            >
              Live
            </button>
            <button
              type="button"
              class="segmented__item"
              :class="{ 'segmented__item--active': provider === 'mock' }"
              @click="provider = 'mock'"
            >
              Mock
            </button>
          </div>

          <div class="segmented">
            <button
              type="button"
              class="segmented__item"
              :class="{ 'segmented__item--active': mode === 'direct' }"
              @click="mode = 'direct'"
            >
              Direct
            </button>
            <button
              type="button"
              class="segmented__item"
              :class="{ 'segmented__item--active': mode === 'buffered' }"
              @click="mode = 'buffered'"
            >
              Buffered
            </button>
          </div>

          <button class="inspector-toggle" type="button" @click="toggleInspector">
            {{ inspectorOpen ? "Hide tools" : "Show tools" }}
          </button>
        </div>
      </header>

      <section v-if="inspectorOpen" class="tool-inspector">
        <div class="tool-inspector__head">
          <div>
            <span class="stage-kicker">MCP Registry</span>
            <h2>Available Tools</h2>
          </div>
          <span class="tool-count">{{ agentTools.length }} tools</span>
        </div>

        <p v-if="agentError" class="tool-error">{{ agentError }}</p>
        <div v-else-if="hasAgentTools" class="tool-grid">
          <article
            v-for="tool in agentTools"
            :key="`${tool.serverName}:${tool.name}`"
            class="tool-tile"
          >
            <div class="tool-tile__head">
              <strong>{{ tool.name }}</strong>
              <span>{{ tool.serverName }}</span>
            </div>
            <p>{{ tool.description || "No description" }}</p>
          </article>
        </div>
        <p v-else class="tool-empty">当前没有可用的 MCP 工具。</p>
      </section>

      <section class="stage-stream">
        <div class="stream-metrics">
          <article class="metric-chip">
            <span>Status</span>
            <strong>{{ statusLabel }}</strong>
          </article>
          <article class="metric-chip">
            <span>Tokens</span>
            <strong>{{ tokenCount }}</strong>
          </article>
          <article class="metric-chip">
            <span>UI commits</span>
            <strong>{{ commitCount }}</strong>
          </article>
          <article class="metric-chip">
            <span>Model</span>
            <strong>{{ activeModel }}</strong>
          </article>
        </div>

        <div class="feed-shell">
          <div v-if="feedRows.length === 0" class="empty-state">
            <div class="empty-state__mark">A</div>
            <h2>Start a new thread</h2>
            <p>从左侧选择历史会话，或者直接在底部输入框里发起新的问题。</p>
          </div>

          <DynamicScroller
            v-else
            ref="scrollerRef"
            class="feed-scroller"
            :items="feedRows"
            :min-item-size="96"
            key-field="id"
            @scroll.passive="handleScroll"
          >
            <template #default="{ item, active, index }">
              <DynamicScrollerItem
                :item="item"
                :active="active"
                :data-index="index"
                :size-dependencies="[
                  item.kind === 'message' ? item.message.content : agentLogs.length,
                  item.kind === 'message' ? item.message.streaming : inspectorOpen,
                ]"
              >
                <article v-if="item.kind === 'message'" class="message-row" :class="`message-row--${item.message.role}`">
                  <div class="message-card" :class="`message-card--${item.message.role}`">
                    <div class="message-card__head">
                      <span class="message-role">{{ item.message.role === "user" ? "You" : "Assistant" }}</span>
                      <span v-if="item.message.streaming" class="message-streaming">Streaming...</span>
                    </div>
                    <div
                      v-if="item.message.role === 'assistant'"
                      class="message-content"
                      v-html="sanitizeAssistantContent(item.message.content || '...')"
                    />
                    <div v-else class="message-content">
                      {{ item.message.content || "..." }}
                    </div>
                  </div>
                </article>

                <article v-else class="trace-card">
                  <div class="trace-card__head">
                    <div>
                      <span class="stage-kicker">Execution</span>
                      <h3>Agent Trace</h3>
                    </div>
                    <span class="trace-status">执行过程</span>
                  </div>

                  <div class="trace-step-list">
                    <details
                      v-for="entry in agentLogs"
                      :key="entry.id"
                      class="trace-step"
                      :open="entry.stage === 'tool_result' || entry.level === 'error'"
                    >
                      <summary class="trace-step__summary">
                        <div class="trace-step__title">
                          <span class="trace-step__badge" :class="`trace-step__badge--${entry.level}`">
                            {{ entry.level === "success" ? "done" : entry.level === "running" ? "run" : entry.level === "error" ? "err" : "info" }}
                          </span>
                          <strong>{{ entry.title }}</strong>
                        </div>
                        <span class="trace-step__stage">{{ entry.stage }}</span>
                      </summary>
                      <div class="trace-step__body">
                        <p>{{ entry.detail }}</p>
                        <small v-if="entry.toolName">tool: {{ entry.toolName }}</small>
                        <div v-if="entry.references?.length" class="reference-grid">
                          <article
                            v-for="reference in entry.references"
                            :key="`${reference.title}-${reference.heading ?? ''}-${reference.source}`"
                            class="reference-card"
                          >
                            <div class="reference-card__head">
                              <strong>{{ reference.title }}</strong>
                              <span>{{ reference.category ?? "source" }}</span>
                            </div>
                            <p class="reference-card__heading">
                              {{ reference.heading || "Matched section" }}
                            </p>
                            <a
                              v-if="reference.sourceUrl"
                              class="reference-card__link"
                              :href="reference.sourceUrl"
                              target="_blank"
                              rel="noreferrer"
                            >
                              {{ reference.sourceUrl }}
                            </a>
                            <p v-else class="reference-card__path">{{ reference.source }}</p>
                            <div class="reference-card__scores">
                              <span>fused {{ formatScore(reference.fusedScore) }}</span>
                              <span>rerank {{ formatScore(reference.rerankScore) }}</span>
                            </div>
                          </article>
                        </div>
                      </div>
                    </details>
                  </div>
                </article>
              </DynamicScrollerItem>
            </template>
          </DynamicScroller>
        </div>
      </section>

      <footer class="composer">
        <textarea
          v-model="prompt"
          class="composer-input"
          placeholder="输入你的问题，或者让 Agent 读取项目代码、调用 MCP 工具。"
        />
        <div class="composer-bar">
          <div class="composer-meta">
            <span>
              {{
                assistantMode === "agent"
                  ? "Tool agent"
                  : assistantMode === "nba"
                    ? "NBA assistant"
                    : "Plain chat"
              }}
            </span>
            <span>{{ prompt.length }} chars</span>
            <span v-if="sidebarLoading">Loading history...</span>
          </div>

          <div class="composer-actions">
            <button class="composer-button composer-button--ghost" type="button" :disabled="!canRetry" @click="retryLastRequest">
              Retry
            </button>
            <button class="composer-button composer-button--ghost" type="button" @click="resetConversation">
              {{ hasActiveConversation ? "Delete current" : "Clear draft" }}
            </button>
            <button class="composer-button composer-button--ghost" type="button" @click="stopStreaming">
              Stop
            </button>
            <button class="composer-button composer-button--primary" type="button" :disabled="status === 'streaming'" @click="startStreaming">
              {{ status === "streaming" ? "Streaming..." : "Send" }}
            </button>
          </div>
        </div>
      </footer>
    </section>
  </main>
</template>
