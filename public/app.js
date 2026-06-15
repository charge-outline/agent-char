import React, { useRef, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);

async function readSSE(response, onMessage) {
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    if (!response.body) {
        throw new Error("ReadableStream is not available in this browser.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let pendingText = "";

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            pendingText += decoder.decode();
            break;
        }

        pendingText += decoder.decode(value, { stream: true });
        const parts = pendingText.split("\n\n");
        pendingText = parts.pop() ?? "";

        for (const part of parts) {
            const lines = part.split("\n");
            const dataLines = [];

            for (const line of lines) {
                if (line.startsWith("data:")) {
                    dataLines.push(line.slice(5).trimStart());
                }
            }

            if (dataLines.length > 0) {
                onMessage(dataLines.join("\n"));
            }
        }
    }

    if (pendingText.trim().length > 0) {
        const lines = pendingText.split("\n");
        const dataLines = [];

        for (const line of lines) {
            if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trimStart());
            }
        }

        if (dataLines.length > 0) {
            onMessage(dataLines.join("\n"));
        }
    }
}

function App() {
    const [prompt, setPrompt] = useState("请用 120 字左右解释一下，为什么 buffer + requestAnimationFrame 更适合流式文本渲染。");
    const [mode, setMode] = useState("direct");
    const [status, setStatus] = useState("idle");
    const [output, setOutput] = useState("");
    const [commitCount, setCommitCount] = useState(0);
    const [tokenCount, setTokenCount] = useState(0);
    const [activeModel, setActiveModel] = useState("qwen-plus / mock fallback");
    const abortRef = useRef(null);

    async function handleSubmit(event) {
        event.preventDefault();

        abortRef.current?.abort();

        const controller = new AbortController();
        abortRef.current = controller;

        setStatus("streaming");
        setOutput("");
        setCommitCount(0);
        setTokenCount(0);

        let renderedText = "";
        let renderedCommits = 0;
        let receivedTokens = 0;
        let rafId = null;
        const tokenBuffer = [];

        const flushBuffer = () => {
            if (tokenBuffer.length === 0) {
                return;
            }

            renderedText += tokenBuffer.join("");
            tokenBuffer.length = 0;
            renderedCommits += 1;

            setOutput(renderedText);
            setCommitCount(renderedCommits);
            setTokenCount(receivedTokens);
        };

        const scheduleFlush = () => {
            if (rafId !== null) {
                return;
            }

            rafId = requestAnimationFrame(() => {
                rafId = null;
                flushBuffer();

                if (tokenBuffer.length > 0) {
                    scheduleFlush();
                }
            });
        };

        const pushToken = (token) => {
            receivedTokens += 1;

            if (mode === "direct") {
                renderedText += token;
                renderedCommits += 1;
                setOutput(renderedText);
                setCommitCount(renderedCommits);
                setTokenCount(receivedTokens);
                return;
            }

            tokenBuffer.push(token);
            scheduleFlush();
        };

        try {
            const response = await fetch("/api/chat", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    message: prompt,
                    mode,
                }),
                signal: controller.signal,
            });

            await readSSE(response, (raw) => {
                if (raw === "[DONE]") {
                    return;
                }

                const payload = JSON.parse(raw);

                if (payload.type === "start") {
                    setActiveModel(payload.model);
                    return;
                }

                if (payload.type === "token") {
                    pushToken(payload.content);
                    return;
                }

                if (payload.type === "error") {
                    throw new Error(payload.message);
                }

                if (payload.type === "done") {
                    return;
                }
            });

            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            flushBuffer();
            setStatus("complete");
        } catch (error) {
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
            }
            flushBuffer();

            if (error?.name === "AbortError") {
                setStatus("cancelled");
                return;
            }

            setStatus("error");
            setOutput((current) => {
                const prefix = current ? `${current}\n\n` : "";
                return `${prefix}[stream error] ${error instanceof Error ? error.message : String(error)}`;
            });
        }
    }

    function handleStop() {
        abortRef.current?.abort();
    }

    return html`
        <main className="shell">
            <section className="hero">
                <div className="eyebrow">ReadableStream + TextDecoder + SSE</div>
                <div className="hero-grid">
                    <div>
                        <h1 className="title">Token Streaming <em>Lab</em></h1>
                        <p className="lead">
                            这个最小实验把链路完整打通了：后端把上游模型输出转成 SSE，
                            前端自己用 <code>ReadableStream</code> + <code>TextDecoder</code> 解析，
                            然后对比“逐 token 直接渲染”和“buffer + requestAnimationFrame 合帧渲染”。
                        </p>
                    </div>
                    <aside className="hero-note">
                        <strong>你现在观察的重点</strong>
                        <div className="muted">
                            同样一段回答，渲染模式不同，<b>UI 提交次数</b>会明显不一样。
                            高频 chunk 到来时，buffer + rAF 会更稳。
                        </div>
                    </aside>
                </div>
            </section>

            <section className="grid">
                <form className="panel stack" onSubmit=${handleSubmit}>
                    <div>
                        <label className="label" htmlFor="prompt">Prompt</label>
                        <textarea
                            id="prompt"
                            className="prompt"
                            value=${prompt}
                            onChange=${(event) => setPrompt(event.target.value)}
                        />
                    </div>

                    <div className="mode-switch">
                        <label className="label">Render Mode</label>

                        <label className="mode-card">
                            <input
                                type="radio"
                                name="mode"
                                value="direct"
                                checked=${mode === "direct"}
                                onChange=${() => setMode("direct")}
                            />
                            <div>
                                <strong>Direct Token Render</strong>
                                <div className="muted">
                                    每收到一个 token 就立刻 setState，最直观，也最容易产生高频渲染。
                                </div>
                            </div>
                        </label>

                        <label className="mode-card">
                            <input
                                type="radio"
                                name="mode"
                                value="buffered"
                                checked=${mode === "buffered"}
                                onChange=${() => setMode("buffered")}
                            />
                            <div>
                                <strong>Buffered + requestAnimationFrame</strong>
                                <div className="muted">
                                    token 先进入缓冲队列，再按浏览器帧节奏批量提交，通常更平滑。
                                </div>
                            </div>
                        </label>
                    </div>

                    <div className="button-row">
                        <button className="button button-primary" type="submit" disabled=${status === "streaming"}>
                            ${status === "streaming" ? "Streaming..." : "Start Streaming"}
                        </button>
                        <button className="button button-secondary" type="button" onClick=${handleStop}>
                            Stop
                        </button>
                    </div>

                    <div>
                        <label className="label">What To Watch</label>
                        <ol className="hint-list">
                            <li>看 Network 里 `/api/chat` 的响应是持续追加的 SSE。</li>
                            <li>看控制台和 UI 提交次数，`direct` 会明显更频繁。</li>
                            <li>切到 `buffered` 后，文本仍是增量出现，但渲染节奏会更平稳。</li>
                        </ol>
                    </div>
                </form>

                <section className="panel stack">
                    <div className="metrics">
                        <div className="metric">
                            <div className="metric-label">Status</div>
                            <div className="metric-value">${status}</div>
                        </div>
                        <div className="metric">
                            <div className="metric-label">Tokens Seen</div>
                            <div className="metric-value">${tokenCount}</div>
                        </div>
                        <div className="metric">
                            <div className="metric-label">UI Commits</div>
                            <div className="metric-value">${commitCount}</div>
                        </div>
                        <div className="metric">
                            <div className="metric-label">Model</div>
                            <div className="metric-value" style=${{ fontSize: "16px", lineHeight: "1.4" }}>
                                ${activeModel}
                            </div>
                        </div>
                    </div>

                    <div className="stream">
                        <div className="stream-header">
                            <h3>Assistant Stream</h3>
                            <div className="status-pill">
                                <span className="status-dot"></span>
                                ${mode === "direct" ? "Direct Render" : "Buffered Render"}
                            </div>
                        </div>
                        <div className="stream-body">
                            ${output || html`<span className="stream-empty">流式回答会在这里一段段长出来。</span>`}
                        </div>
                    </div>
                </section>
            </section>
        </main>
    `;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
