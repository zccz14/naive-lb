# naive-lb

NaiveAI（`api.naive.ai`）的 Responses API 门面。NaiveAI 只提供 OpenAI Chat Completions 与 Anthropic Messages，没有 Responses；而 Cybion 只说 Responses。这个 Worker 就是那道翻译缝：收 Responses 请求，驱动 NaiveAI 的 Chat Completions，再把 Chat 的增量装配成 Responses 事件流。

NormAI 仍然不做任何协议转换，它只是把请求转发到这里。

## 端点

| 端点 | 作用 |
|---|---|
| `POST /v1/responses` | Responses ⇄ Chat 双向翻译（流式与非流式） |
| `POST /v1/chat/completions` | 原生 Chat 直通（剥掉 `service_tier`），给非 Responses 客户端与调试用 |
| `GET /v1/models` | 静态模型表（`naive-n0.5-flash` / `naive-n0.5-lite`） |
| `GET /health` | 存活 |

除 `/health` 外都需要 `Authorization: Bearer <GATEWAY_TOKEN>`。

**故意不实现 `/v1/requests/:id`**：NormAI 用「404 且 `error.reason === "request_not_found"`」判断一个上游是不是负载均衡器、要按实收结算。这里没有费用账本，所以必须保持普通 404，让 NormAI 按模型行的 token 价格计费。加这个字段会变成「永远结算不出来」，等于白送。

## 几条实测得出的决定

- **`service_tier` 一律丢弃**。NaiveAI 的 `ultrafast` 贵 10 倍且不回显 tier，接受了就无法核对，调用方一句话就能把成本乘十，而模型行还按 standard 价收费。
- **`max_tokens` 只在调用方显式要求时透传**。NaiveAI 把它当作「思考 + 正文」的总预算，给小了会被思考吃干净、正文为空（实测 `max_tokens: 16` → `text_tokens: 0`、`finish_reason: length`）。
- **`reasoning_content` 增量翻译成 reasoning item 的 summary part**，Cybion 因此还能渲染思考过程。
- **流式 usage 上游总会给**（带不带 `stream_options.include_usage` 都测过），但仍显式索要。
- 内置工具（`image_generation` / `web_search` / `audio_transcription`）没有 Chat 对等物，直接丢弃；只保留 `function` 工具并转成嵌套形状。
- `reasoning` / `include` / `store` 丢弃——Cybion 每轮全量重放历史，不需要服务端状态。

## 部署

```bash
npx wrangler deploy
npx wrangler secret put NAIVE_API_KEY     # sk-nv-…
npx wrangler secret put GATEWAY_TOKEN     # NormAI 侧的 api_key 填这个
```

`NAIVE_BASE` 在 `wrangler.toml` 的 `[vars]` 里，默认 `https://api.naive.ai/v1`。

## 自测

```bash
BASE=https://naive-lb.zccz14.workers.dev GATEWAY_TOKEN=… ./test.sh
```

## 注意

- 国内网络（MacMini 上的代理 fake-ip）解析 `api.naive.ai` 到 `198.18.6.191`，TLS 握手直接失败；联调请走本 Worker 或境外机器。
- 提示词会在 Cloudflare 边缘解密一次，这是选择 Worker 而非自建进程的代价。
