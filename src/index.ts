/**
 * naive-lb — the Responses-API face of NaiveAI.
 *
 * NaiveAI (https://api.naive.ai) speaks OpenAI Chat Completions and Anthropic
 * Messages; it has no Responses API. Cybion speaks Responses only, so this
 * Worker is the translation seam: it accepts Responses requests, drives NaiveAI's
 * Chat Completions endpoint, and assembles a Responses event stream out of the
 * Chat chunks. NormAI still does no protocol conversion — it forwards to us.
 *
 * Deliberate choices, each one measured against the live API (2026-11-15):
 *
 * - `service_tier` is always dropped. NaiveAI bills `ultrafast` at 10x and does
 *   not echo the tier back, so an accepted tier is unverifiable and would let a
 *   caller multiply our cost while the model row bills the standard rate.
 * - `max_tokens` is passed through only when the caller asked. NaiveAI treats it
 *   as one budget covering reasoning + text, so a small cap is burned entirely by
 *   thinking and returns empty content.
 * - `reasoning_content` deltas become a Responses `reasoning` item with summary
 *   parts, so Cybion can still render thinking.
 * - The upstream always reports usage on a stream, with or without
 *   `stream_options.include_usage`; we still ask for it explicitly.
 * - `/v1/requests/:id` is NOT implemented. NormAI marks a provider as
 *   load-balancer-settled when that route answers 404 with
 *   `error.reason === "request_not_found"`; we have no cost ledger, so we must
 *   keep answering plain 404 and let NormAI bill the model rows by token counts.
 */

interface Env {
  NAIVE_API_KEY: string;
  GATEWAY_TOKEN: string;
  NAIVE_BASE?: string;
}

const DEFAULT_BASE = "https://api.naive.ai/v1";
const enc = new TextEncoder();

const MODELS = [
  { id: "naive-n0.5-flash", object: "model", created: 1760000000, owned_by: "naive" },
  { id: "naive-n0.5-lite", object: "model", created: 1760000000, owned_by: "naive" },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(status: number, message: string, code: string): Response {
  return json({ error: { message, type: "gateway_error", code } }, status);
}

/** Shared-secret gate: NormAI holds one key, we hold the real NaiveAI key. */
function authorized(req: Request, env: Env): boolean {
  const expected = (env.GATEWAY_TOKEN || "").trim();
  if (!expected) return false;
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i += 1) {
    diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

const newId = (prefix: string) => prefix + crypto.randomUUID().replace(/-/g, "");

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" || path === "/health") {
      return json({ ok: true, service: "naive-lb" });
    }
    if (!authorized(req, env)) {
      return errorResponse(401, "invalid gateway token", "unauthorized");
    }
    const base = (env.NAIVE_BASE || DEFAULT_BASE).replace(/\/+$/, "");

    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      return json({ object: "list", data: MODELS });
    }
    if (req.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
      return handleResponses(req, env, base);
    }
    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      return handleChatPassthrough(req, env, base);
    }
    return errorResponse(404, "not found", "not_found");
  },
};

/* ------------------------------ request side ------------------------------ */

function textFromParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const anyPart = part as Record<string, unknown>;
    if (typeof anyPart.text === "string") out += anyPart.text;
    else if (typeof anyPart.output === "string") out += anyPart.output;
  }
  return out;
}

/** Responses request body → NaiveAI Chat Completions request body. */
function toChatRequest(body: Record<string, any>): Record<string, any> {
  const messages: any[] = [];

  const pushToolCall = (call: Record<string, any>) => {
    const name = String(call.name || call.function?.name || "");
    const args =
      typeof call.arguments === "string"
        ? call.arguments
        : JSON.stringify(call.arguments ?? {});
    const entry = {
      id: String(call.call_id || call.id || newId("call_")),
      type: "function",
      function: { name, arguments: args },
    };
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant") {
      last.tool_calls = last.tool_calls || [];
      last.tool_calls.push(entry);
      if (typeof last.content !== "string") last.content = "";
    } else {
      messages.push({ role: "assistant", content: "", tool_calls: [entry] });
    }
  };

  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== "object") continue;
      const type = item.type;
      if (type === "message" || (!type && item.role)) {
        const role =
          item.role === "assistant"
            ? "assistant"
            : item.role === "system" || item.role === "developer"
              ? "system"
              : "user";
        messages.push({ role, content: textFromParts(item.content) });
      } else if (type === "function_call") {
        pushToolCall(item);
      } else if (type === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: String(item.call_id || item.id || ""),
          content:
            typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
        });
      }
      // `reasoning`, `item_reference`, `web_search_call`, `image_generation_call`:
      // no Chat Completions equivalent, dropped. Cybion replays history in
      // portable form when a strict provider refuses those fields.
    }
  }

  if (messages.length === 0) messages.push({ role: "user", content: "" });

  const requestedModel = String(body.model || "");
  const payload: Record<string, any> = {
    model: requestedModel.replace(/\[[^\]]*\]$/, ""),
    messages,
  };

  if (Array.isArray(body.tools)) {
    const tools: any[] = [];
    for (const tool of body.tools) {
      if (!tool || typeof tool !== "object" || tool.type !== "function") continue;
      if (tool.function && tool.function.name) {
        tools.push({ type: "function", function: tool.function });
        continue;
      }
      if (!tool.name) continue;
      const fn: Record<string, any> = { name: tool.name };
      if (tool.description) fn.description = tool.description;
      if (tool.parameters) fn.parameters = tool.parameters;
      if (typeof tool.strict === "boolean") fn.strict = tool.strict;
      tools.push({ type: "function", function: fn });
    }
    if (tools.length > 0) {
      payload.tools = tools;
      const choice = body.tool_choice;
      if (choice === "auto" || choice === "none" || choice === "required") {
        payload.tool_choice = choice;
      } else if (choice && typeof choice === "object" && choice.name) {
        payload.tool_choice = { type: "function", function: { name: choice.name } };
      }
      if (typeof body.parallel_tool_calls === "boolean") {
        payload.parallel_tool_calls = body.parallel_tool_calls;
      }
    }
  }

  // Budget: reasoning and text share it, so we only honour an explicit cap.
  if (typeof body.max_output_tokens === "number" && body.max_output_tokens > 0) {
    payload.max_tokens = body.max_output_tokens;
  }
  if (typeof body.temperature === "number") payload.temperature = body.temperature;
  if (typeof body.top_p === "number") payload.top_p = body.top_p;

  const format = body.text?.format;
  if (format?.type === "json_schema" && format.schema) {
    payload.response_format = {
      type: "json_schema",
      json_schema: {
        name: format.name || "response",
        schema: format.schema,
        ...(typeof format.strict === "boolean" ? { strict: format.strict } : {}),
      },
    };
  } else if (format?.type === "json_object") {
    payload.response_format = { type: "json_object" };
  }

  // `service_tier`, `reasoning`, `include`, `store`: dropped on purpose.
  return payload;
}

/* ----------------------------- response side ------------------------------ */

function usageOf(usage: any) {
  const input = Number(usage?.prompt_tokens ?? 0);
  const output = Number(usage?.completion_tokens ?? 0);
  const cached = Number(
    usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? 0,
  );
  const reasoning = Number(usage?.completion_tokens_details?.reasoning_tokens ?? 0);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: Number(usage?.total_tokens ?? input + output),
  };
}

function responseEnvelope(
  id: string,
  model: string,
  createdAt: number,
  status: string,
  output: any[],
  usage: any | null,
) {
  return {
    id,
    object: "response",
    created_at: createdAt,
    status,
    model,
    output,
    usage,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: null,
    text: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    max_output_tokens: null,
  };
}

/** Chat Completions reply → Responses object (non-streaming path). */
function fromChatResponse(chat: any, model: string) {
  const choice = chat?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const output: any[] = [];

  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    output.push({
      id: newId("rs_"),
      type: "reasoning",
      summary: [{ type: "summary_text", text: message.reasoning_content }],
    });
  }
  if (typeof message.content === "string" && message.content) {
    output.push({
      id: newId("msg_"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: message.content, annotations: [] }],
    });
  }
  for (const call of message.tool_calls ?? []) {
    output.push({
      id: newId("fc_"),
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "",
    });
  }
  return responseEnvelope(
    newId("resp_"),
    chat?.model || model,
    Number(chat?.created ?? Math.floor(Date.now() / 1000)),
    choice.finish_reason === "length" ? "incomplete" : "completed",
    output,
    usageOf(chat?.usage),
  );
}

/** Chat Completions SSE → Responses SSE. */
function translateStream(model: string) {
  const decoder = new TextDecoder();
  let buffer = "";
  let seq = 0;
  const responseId = newId("resp_");
  const createdAt = Math.floor(Date.now() / 1000);
  let nextIndex = 0;
  let reasoning: any = null;
  let message: any = null;
  let usage: any = null;
  const calls = new Map<number, any>();
  let emit: (type: string, payload: Record<string, unknown>) => void = () => {};

  const send = (type: string, payload: Record<string, unknown>) =>
    emit(type, { type, sequence_number: seq++, ...payload });

  const ensureReasoning = () => {
    if (reasoning) return reasoning;
    reasoning = { id: newId("rs_"), output_index: nextIndex++, text: "" };
    send("response.output_item.added", {
      output_index: reasoning.output_index,
      item: { id: reasoning.id, type: "reasoning", summary: [] },
    });
    send("response.reasoning_summary_part.added", {
      item_id: reasoning.id,
      output_index: reasoning.output_index,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });
    return reasoning;
  };

  const ensureMessage = () => {
    if (message) return message;
    message = { id: newId("msg_"), output_index: nextIndex++, text: "" };
    send("response.output_item.added", {
      output_index: message.output_index,
      item: { id: message.id, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    send("response.content_part.added", {
      item_id: message.id,
      output_index: message.output_index,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    return message;
  };

  const handleDelta = (delta: any) => {
    if (!delta || typeof delta !== "object") return;
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      const item = ensureReasoning();
      item.text += delta.reasoning_content;
      send("response.reasoning_summary_text.delta", {
        item_id: item.id,
        output_index: item.output_index,
        summary_index: 0,
        delta: delta.reasoning_content,
      });
    }
    if (typeof delta.content === "string" && delta.content) {
      const item = ensureMessage();
      item.text += delta.content;
      send("response.output_text.delta", {
        item_id: item.id,
        output_index: item.output_index,
        content_index: 0,
        delta: delta.content,
      });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = Number(call?.index ?? 0);
        let state = calls.get(index);
        if (!state) {
          state = {
            id: newId("fc_"),
            call_id: String(call?.id || newId("call_")),
            name: String(call?.function?.name ?? ""),
            args: "",
            output_index: nextIndex++,
          };
          calls.set(index, state);
          send("response.output_item.added", {
            output_index: state.output_index,
            item: {
              id: state.id,
              type: "function_call",
              status: "in_progress",
              call_id: state.call_id,
              name: state.name,
              arguments: "",
            },
          });
        }
        const argDelta = call?.function?.arguments;
        if (typeof argDelta === "string" && argDelta) {
          state.args += argDelta;
          send("response.function_call_arguments.delta", {
            item_id: state.id,
            output_index: state.output_index,
            delta: argDelta,
          });
        }
      }
    }
  };

  const consume = (line: string) => {
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") return;
    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (event?.usage) usage = event.usage;
    const delta = event?.choices?.[0]?.delta;
    if (delta) handleDelta(delta);
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      emit = (type, payload) =>
        controller.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`));
      send("response.created", {
        response: responseEnvelope(responseId, model, createdAt, "in_progress", [], null),
      });
      send("response.in_progress", {
        response: responseEnvelope(responseId, model, createdAt, "in_progress", [], null),
      });
    },
    transform(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        consume(line);
        newline = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer) consume(buffer.replace(/\r$/, ""));

      const finished: any[] = [];
      if (reasoning) {
        send("response.reasoning_summary_text.done", {
          item_id: reasoning.id,
          output_index: reasoning.output_index,
          summary_index: 0,
          text: reasoning.text,
        });
        send("response.reasoning_summary_part.done", {
          item_id: reasoning.id,
          output_index: reasoning.output_index,
          summary_index: 0,
          part: { type: "summary_text", text: reasoning.text },
        });
        const item = {
          id: reasoning.id,
          type: "reasoning",
          summary: [{ type: "summary_text", text: reasoning.text }],
        };
        send("response.output_item.done", { output_index: reasoning.output_index, item });
        finished.push({ index: reasoning.output_index, item });
      }
      if (message) {
        send("response.output_text.done", {
          item_id: message.id,
          output_index: message.output_index,
          content_index: 0,
          text: message.text,
        });
        send("response.content_part.done", {
          item_id: message.id,
          output_index: message.output_index,
          content_index: 0,
          part: { type: "output_text", text: message.text, annotations: [] },
        });
        const item = {
          id: message.id,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: message.text, annotations: [] }],
        };
        send("response.output_item.done", { output_index: message.output_index, item });
        finished.push({ index: message.output_index, item });
      }
      for (const state of calls.values()) {
        send("response.function_call_arguments.done", {
          item_id: state.id,
          output_index: state.output_index,
          arguments: state.args,
        });
        const item = {
          id: state.id,
          type: "function_call",
          status: "completed",
          call_id: state.call_id,
          name: state.name,
          arguments: state.args,
        };
        send("response.output_item.done", { output_index: state.output_index, item });
        finished.push({ index: state.output_index, item });
      }

      const output = finished.sort((a, b) => a.index - b.index).map((entry) => entry.item);
      send("response.completed", {
        response: responseEnvelope(responseId, model, createdAt, "completed", output, usageOf(usage)),
      });
    },
  });
}

/* -------------------------------- handlers -------------------------------- */

async function handleResponses(req: Request, env: Env, base: string): Promise<Response> {
  let body: Record<string, any>;
  try {
    body = (await req.json()) as Record<string, any>;
  } catch {
    return errorResponse(400, "request body must be JSON", "invalid_json");
  }
  const model = String(body.model || "");
  const wantsStream = body.stream !== false;
  const chat = toChatRequest(body);
  chat.stream = wantsStream;
  if (wantsStream) chat.stream_options = { include_usage: true };

  const upstream = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.NAIVE_API_KEY}`,
      "content-type": "application/json",
      accept: wantsStream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(chat),
  });

  if (!upstream.ok) {
    const detail = await upstream.text();
    let message = detail.slice(0, 2000);
    try {
      const parsed = JSON.parse(detail);
      message = parsed?.error?.message ?? message;
    } catch {
      /* keep the raw text */
    }
    return json(
      { error: { message, type: "upstream_error", code: String(upstream.status) } },
      upstream.status,
    );
  }

  if (!wantsStream) {
    const chatReply = await upstream.json();
    return json(fromChatResponse(chatReply, model));
  }

  return new Response(upstream.body!.pipeThrough(translateStream(model)), {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/** Native Chat Completions passthrough, for clients that speak it directly. */
async function handleChatPassthrough(req: Request, env: Env, base: string): Promise<Response> {
  let body: Record<string, any> = {};
  const raw = await req.text();
  if (raw) {
    try {
      body = JSON.parse(raw) as Record<string, any>;
    } catch {
      return errorResponse(400, "request body must be JSON", "invalid_json");
    }
  }
  delete body.service_tier;

  const upstream = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.NAIVE_API_KEY}`,
      "content-type": "application/json",
      accept: req.headers.get("accept") || "application/json",
    },
    body: JSON.stringify(body),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-cache",
    },
  });
}
