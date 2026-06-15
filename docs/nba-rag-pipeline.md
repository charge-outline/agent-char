# NBA RAG Pipeline

这份文档描述当前项目里 `NBA Assistant` 模式的 RAG 实现方式，重点覆盖：

- 知识源组织
- 文档切片策略
- 向量化与落盘
- 混合召回与重排
- 前后端请求链路
- 运行命令与目录位置

## 1. 当前目标

当前这版不是做一个“大而全”的体育知识平台，而是做一个可演示、可继续扩展的 `NBA 知识助手`。

它和项目里另外两种模式的区别是：

- `Chat`
  - 直接与上游模型对话
  - 不主动查知识库

- `Tool Agent`
  - 让模型决定是否调用 MCP 工具
  - 更适合读代码、读文件、调用外部工具

- `NBA Assistant`
  - 先做知识检索
  - 再把检索到的上下文交给模型回答
  - 更适合 NBA 规则、术语、历史、球队风格、球员类型等问题

## 2. 当前知识源

当前语料放在：

- [knowledge/nba](E:/coder/react/llm-rag-try/knowledge/nba)

现阶段保持“小而稳”，只放少量可控文档，不故意堆很多内容。

当前语料主要包括：

- 规则类
  - 比赛结构
  - 违例与犯规
  - 干扰球、回放等

- 术语类
  - TS%
  - eFG%
  - Usage Rate
  - Offensive / Defensive Rating

- 历史类
  - 联盟演化
  - 奖项和纪录

- 球队/球员理解类
  - 阵容角色
  - 球员 archetype

另外我补了一个可选抓取脚本：

- [apps/server/python/fetch_nba_corpus.py](E:/coder/react/llm-rag-try/apps/server/python/fetch_nba_corpus.py)

它的定位不是无限抓数据，而是：

- 从官方 NBA 页面抓少量公开资料
- 转成 markdown
- 作为后续补充语料的入口

如果项目答辩或演示只需要“意思一下”，完全可以先维持现在这批小语料。

## 3. 切片策略

切片逻辑在：

- [apps/server/python/nba_rag.py](E:/coder/react/llm-rag-try/apps/server/python/nba_rag.py)

### 3.1 切片原则

先按“结构”切，再按“长度”切。

也就是说，不是上来就按固定字数硬切，而是先按 markdown 标题拆：

- `#`
- `##`
- `###`

这样做的目的，是尽量保证一个 chunk 只围绕一个局部主题。

例如：

- `True Shooting Percentage`
- `Usage Rate`
- `Violations and Penalties`

这些主题天然就适合做成独立 chunk。

### 3.2 当前 chunk 参数

当前脚本里的参数是：

- `TARGET_CHARS = 650`
- `MIN_CHARS = 260`
- `OVERLAP_CHARS = 100`

这意味着：

- 理想 chunk 长度大约 `650` 个字符左右
- 如果遇到过长内容，会在接近这个长度时优先寻找换行点切开
- 相邻 chunk 之间保留 `100` 字符重叠，避免语义断裂

### 3.3 为什么这样切

如果 chunk 太长：

- 一个块里会塞进太多主题
- 向量语义会变“发散”
- rerank 时噪音更大
- 模型上下文浪费更多 token

如果 chunk 太短：

- 上下文容易不完整
- 命中后也不够回答
- 会变成“召回到很多碎片句子”

当前这版是折中：

- 不太长
- 不太碎
- 适合本地演示和中小规模知识库

## 4. 向量化与索引

### 4.1 Embedding 模型

当前使用：

- `BAAI/bge-m3`

它用于把 chunk 文本转成 embedding。

### 4.2 Chroma 持久化

不是只存在内存里，而是会落盘。

当前 Chroma 持久化目录：

- `E:\coder\react\llm-rag-try\storage\chroma\nba`

这里会保存：

- `chroma.sqlite3`
- collection 相关数据目录

这意味着：

- 服务重启后索引还在
- 不需要每次启动都重新生成向量
- 比纯内存模式更适合真实项目

### 4.3 检索缓存

除了 Chroma 本身，还会保留一份 chunk 清单缓存：

- [storage/rag/nba/chunks.json](E:/coder/react/llm-rag-try/storage/rag/nba/chunks.json)

这份缓存里记录：

- 当前 collection 名称
- chunk 总数
- 文档总数
- 每个 chunk 的元数据

它主要用于：

- 做 BM25
- 做调试
- 看 seed 后的实际结果

## 5. 混合召回流程

当前检索不是只做向量检索，而是三段式：

### 5.1 第一步：向量召回

用 `bge-m3` 把用户问题转成向量，然后在 Chroma 里查相似 chunk。

当前默认：

- `VECTOR_TOP_K = 8`

### 5.2 第二步：BM25 关键词召回

会同时对 chunk 文本做分词，再基于 BM25 做关键词召回。

当前默认：

- `BM25_TOP_K = 8`

BM25 的意义在于：

- 对术语名
- 规则名
- 奖项名
- 球员/球队显式名称

这类“精确词”命中更稳。

### 5.3 第三步：融合

当前使用 `RRF（Reciprocal Rank Fusion）` 融合向量结果与 BM25 结果。

作用是：

- 兼顾语义相近
- 兼顾关键词精确匹配

### 5.4 第四步：Rerank

融合后的候选结果不会直接进模型，而是再走一次重排。

当前使用：

- `BAAI/bge-reranker-v2-m3`

Rerank 的作用是：

- 输入：`query + candidate chunks`
- 输出：更细粒度的相关性分数

这样最终排到前面的 chunk，通常更贴近用户真正的问题。

### 5.5 最终返回

当前最终送给模型的 chunk 数量是：

- `FINAL_TOP_K = 5`

这些 chunk 会被整理成上下文，进入最终回答阶段。

## 6. 回答生成流程

后端入口在：

- [apps/server/src/index.ts](E:/coder/react/llm-rag-try/apps/server/src/index.ts)

流式回答逻辑在：

- [apps/server/src/streaming.ts](E:/coder/react/llm-rag-try/apps/server/src/streaming.ts)

当请求里带上：

```ts
assistantMode: "nba"
```

后端会：

1. 检查 NBA 知识库状态
2. 调 Python 脚本做检索
3. 拿到混合召回 + rerank 的结果
4. 把这些上下文拼进 system prompt
5. 再请求上游模型流式回答
6. 通过 SSE 把 token 一路推给前端

所以它不是“直接把检索结果原样返回”，而是：

`检索 -> 组装上下文 -> 模型生成 -> SSE流式输出`

## 7. 前端展示链路

前端主页面在：

- [apps/web/src/views/ChatView.vue](E:/coder/react/llm-rag-try/apps/web/src/views/ChatView.vue)

当前前端支持三种模式切换：

- `Chat`
- `Tool Agent`
- `NBA Assistant`

NBA 模式下，前端会看到：

- 流式回答
- Agent / retrieval trace
- 当前模型与状态

后续如果继续增强，可进一步把“命中的知识来源卡片”单独展示在回答下方。

## 8. 运行命令

### 8.1 抓取少量官方语料（可选）

```bash
pnpm rag:fetch:nba
```

说明：

- 这一步不是必须
- 当前项目已经有一批种子文档
- 如果你不想让数据变太多，可以先不跑

### 8.2 生成 / 更新 Chroma 索引

```bash
pnpm rag:seed:nba
```

### 8.3 查看当前知识库状态

```bash
pnpm rag:status:nba
```

### 8.4 启动整个项目

```bash
pnpm dev
```

## 9. 环境变量

RAG 相关环境变量示例写在：

- [.env.example](E:/coder/react/llm-rag-try/.env.example)

核心项包括：

- `RAG_ENABLED`
- `RAG_COLLECTION_NAME`
- `RAG_CORPUS_DIR`
- `RAG_CACHE_DIR`
- `RAG_CHROMA_DIR`
- `RAG_EMBEDDING_MODEL`
- `RAG_RERANKER_MODEL`

当前推荐：

- `RAG_EMBEDDING_MODEL=BAAI/bge-m3`
- `RAG_RERANKER_MODEL=BAAI/bge-reranker-v2-m3`

## 10. 当前实现的优点与边界

### 优点

- 有持久化，不是纯内存 demo
- 有明确 chunk 策略
- 有 BM25 + 向量 + rerank，不是单一检索
- 可以通过 SSE 直接接入现有流式聊天 UI
- 和当前普通聊天 / MCP Agent 模式互不冲突

### 边界

- 当前语料规模不大，更适合演示与第一版答辩
- 还没有做用户自定义知识库上传
- 还没有做复杂的 metadata filter
- 还没有做 query rewrite、多轮检索规划
- rerank 目前是在 Python 侧单独调接口，不是全链路都在 Node 里执行

## 11. 一句话概括当前方案

当前 NBA RAG 方案可以概括为：

`少量官方/整理语料 -> 结构化切片 -> bge-m3 向量化 -> Chroma 持久化 -> BM25 + 向量混合召回 -> bge-reranker-v2-m3 精排 -> 上游模型基于上下文流式生成回答`
