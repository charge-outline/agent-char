<script setup lang="ts">
import DOMPurify from "dompurify";
import { computed, nextTick, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { DynamicScroller, DynamicScrollerItem } from "vue-virtual-scroller";
import "./ChatView.css";
import { fetchBootstrap, logout, openChatStream } from "../lib/api";
import { useAuthState } from "../lib/auth";
import { readSSE } from "../lib/readSse";
import type { ErrorCode, MemoryMessage, Provider, RenderMode, SSEPayload } from "../types";

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
};

const BUFFER_FLUSH_THRESHOLD = 24;
const auth = useAuthState();
const router = useRouter();

const prompt = ref("请解释一下，为什么前端在处理高频流式 chunk 时，需要用 buffer 队列配合 requestAnimationFrame 合帧渲染。");
const mode = ref<RenderMode>("direct");
const provider = ref<Provider>("live");
const status = ref<ChatStatus>("loading");
const messages = ref<ChatMessage[]>([]);
const commitCount = ref(0);
const tokenCount = ref(0);
const activeModel = ref("qwen-plus");
const activeProvider = ref<Provider>("live");
const abortController = ref<AbortController | null>(null);
const scrollerRef = ref<{ $el?: HTMLElement } | null>(null);
const userScrolledUp = ref(false);
const nextMessageId = ref(1);
const lastRequest = ref<RequestSnapshot | null>(null);
const conversationId = ref<number | null>(null);

const providerSummary = computed(() =>
    activeProvider.value === "mock"
        ? "Burst mock stream for render stress testing"
        : "Live model stream from the upstream provider",
);

const hasMessages = computed(() => messages.value.length > 0);
const canRetry = computed(
    () =>
        !!lastRequest.value &&
        (status.value === "network_error" ||
            status.value === "upstream_error" ||
            status.value === "server_error"),
);
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

function sanitizeAssistantContent(content: string) {
    return DOMPurify.sanitize(content.replace(/\n/g, "<br/>"), {
        USE_PROFILES: { html: true },
    });
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

function resetConversation() {
    abortController.value?.abort();
    messages.value = [];
    commitCount.value = 0;
    tokenCount.value = 0;
    status.value = "idle";
    userScrolledUp.value = false;
    lastRequest.value = null;
}

async function bootstrapChat() {
    status.value = "loading";
    const payload = await fetchBootstrap();
    conversationId.value = payload.conversation?.id ?? null;
    messages.value = payload.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        streaming: message.status === "streaming",
        status: message.status,
    }));
    nextMessageId.value =
        messages.value.reduce((maxId, message) => Math.max(maxId, message.id), 0) + 1;
    status.value = "idle";
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
                return;
            }

            if (payload.type === "token") {
                pushToken(payload.content);
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
            targetMessage.content += `${
                targetMessage.content ? "\n\n" : ""
            }[${
                status.value === "network_error"
                    ? "network interrupted"
                    : status.value === "upstream_error"
                      ? "upstream error"
                      : "server error"
            }] ${error instanceof Error ? error.message : String(error)}`;
        }
        syncMessages(draftMessages, true);
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
  <main class="shell">
    <section class="hero panel">
      <div class="eyebrow">Trusted session · sanitized output</div>
      <div class="hero-grid">
        <div>
          <h1 class="title">
            Authenticated <span>Chat Console</span>
          </h1>
          <p class="lead">
            现在这页已经不只是实验台了：用户身份来自双 Token 方案，聊天消息落到 MySQL，
            assistant 回复渲染先走 <code>DOMPurify</code>，再展示到界面上。
          </p>
        </div>
        <aside class="hero-note">
          <strong>Current operator</strong>
          <p>
            {{ auth.state.user?.username }} · {{ auth.state.user?.email }}
          </p>
          <div class="hero-actions">
            <button class="secondary-button" type="button" @click="handleLogout">Logout</button>
          </div>
        </aside>
      </div>
    </section>

    <section class="content">
      <form class="panel control-panel" @submit.prevent="startStreaming">
        <div class="field">
          <label class="label" for="prompt">Prompt</label>
          <textarea id="prompt" v-model="prompt" class="prompt" />
        </div>

        <div class="cluster">
          <div class="section-title">Render Strategy</div>
          <label class="choice">
            <input v-model="mode" type="radio" value="direct" />
            <div>
              <strong>Direct Token Render</strong>
              <p>每来一个 token 就立即提交一次 UI，最直观，也最容易出现高频重渲染。</p>
            </div>
          </label>
          <label class="choice">
            <input v-model="mode" type="radio" value="buffered" />
            <div>
              <strong>Buffered + requestAnimationFrame</strong>
              <p>token 先进缓冲队列，再按浏览器帧节奏批量 flush，更适合高频 chunk。</p>
            </div>
          </label>
        </div>

        <div class="cluster">
          <div class="section-title">Provider</div>
          <label class="choice">
            <input v-model="provider" type="radio" value="live" />
            <div>
              <strong>Live Model</strong>
              <p>真实上游模型返回的流，更接近对话助手的生产链路。</p>
            </div>
          </label>
          <label class="choice">
            <input v-model="provider" type="radio" value="mock" />
            <div>
              <strong>Mock Stream</strong>
              <p>本地 burst mock，用来刻意制造一帧内多个 token 的场景。</p>
            </div>
          </label>
        </div>

        <div class="actions">
          <button class="button button-primary" type="submit" :disabled="status === 'streaming'">
            {{ status === "streaming" ? "Streaming..." : "Start Lab" }}
          </button>
          <button class="button button-secondary" type="button" @click="stopStreaming">Stop</button>
          <button class="button button-accent" type="button" :disabled="!canRetry" @click="retryLastRequest">
            Retry
          </button>
          <button class="button button-ghost" type="button" @click="resetConversation">Reset</button>
        </div>

        <div class="note">
          <div class="section-title">Security Stack</div>
          <ol>
            <li>Access token kept in memory only.</li>
            <li>Refresh token stored in HttpOnly Cookie.</li>
            <li>Assistant content sanitized with DOMPurify before HTML render.</li>
            <li>Conversation and message history persisted in MySQL.</li>
          </ol>
        </div>
      </form>

      <section class="panel stage-panel">
        <div class="metrics">
          <article class="metric">
            <span class="metric-label">Status</span>
            <strong>{{ statusLabel }}</strong>
          </article>
          <article class="metric">
            <span class="metric-label">Tokens Seen</span>
            <strong>{{ tokenCount }}</strong>
          </article>
          <article class="metric">
            <span class="metric-label">UI Commits</span>
            <strong>{{ commitCount }}</strong>
          </article>
          <article class="metric">
            <span class="metric-label">Provider</span>
            <strong class="metric-compact">{{ activeProvider }}</strong>
          </article>
          <article class="metric">
            <span class="metric-label">Model</span>
            <strong class="metric-compact">{{ activeModel }}</strong>
          </article>
        </div>

        <div class="stream-card">
          <div class="stream-head">
            <div>
              <h2>Assistant Stream</h2>
              <p>{{ providerSummary }}</p>
            </div>
            <div class="pill">
              {{ mode === "direct" ? "Direct Render" : "Buffered Render" }}
            </div>
          </div>

          <div class="stream-body">
            <div v-if="hasMessages" class="stream-scroll-shell">
              <DynamicScroller
                ref="scrollerRef"
                class="stream-scroller"
                :items="messages"
                :min-item-size="84"
                key-field="id"
                @scroll.passive="handleScroll"
              >
                <template #default="{ item, active, index }">
                  <DynamicScrollerItem
                    :item="item"
                    :active="active"
                    :data-index="index"
                    :size-dependencies="[item.content, item.streaming, item.status]"
                  >
                    <article class="message-row" :class="`message-row--${item.role}`">
                      <div class="message-card" :class="`message-card--${item.role}`">
                        <div class="message-meta">
                          <span class="message-role">
                            {{ item.role === "user" ? "You" : "Assistant" }}
                          </span>
                          <span v-if="item.streaming" class="message-streaming">Streaming…</span>
                        </div>
                        <div
                          v-if="item.role === 'assistant'"
                          class="message-content"
                          v-html="sanitizeAssistantContent(item.content || '…')"
                        />
                        <div v-else class="message-content">
                          {{ item.content || "…" }}
                        </div>
                      </div>
                    </article>
                  </DynamicScrollerItem>
                </template>
              </DynamicScroller>
            </div>
            <span v-else class="placeholder">
              用户消息和 assistant 的流式回复都会保存在这里。你可以连续发送多轮，然后观察不同 provider 和 render mode 的表现。
            </span>
          </div>
        </div>
      </section>
    </section>
  </main>
</template>
