import process from "node:process";

import { TOOL_SCHEMAS, createToolRuntime } from "./tools.mjs";

export const DEFAULT_ENDPOINT = process.env.APPRENTICE_ENDPOINT || "http://localhost:11434/v1";

const DEFAULT_MAX_STEPS = 40;

const DEFAULT_SYSTEM_PROMPT = [
  "You are an apprentice coder working under a senior orchestrator (Claude Opus).",
  "You have these tools: Read, Write, Edit, Glob, Grep. You do NOT have shell access — the senior runs commands.",
  "Your job: execute the user's coding task by calling tools. Do not chat — act.",
  "",
  "Rules:",
  "1. You MUST Read a file in this task before you can Edit it.",
  "2. Prefer Edit (str_replace) over rewriting whole files. Keep edits surgical.",
  "3. When an Edit's old_string has no unique match, re-Read the surrounding lines and retry with more context (or set replace_all).",
  "4. All paths resolve inside the workspace. Attempts to touch system paths (/etc, ~/.ssh, etc.) will be rejected — do not retry them.",
  "5. If the task touches security, auth, database migrations, payment, or architectural patterns, stop and surface the concern in your final reply — do not silently write risky code.",
  "6. Finish with a concise summary of what you changed. The senior will review.",
  "7. Produce valid JSON function-call arguments — no prose inside tool_call fields."
].join("\n");

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

// Length-cap without collapsing whitespace — preserves diff/code structure.
function truncatePreservingStructure(text, limit = 2000) {
  const str = String(text ?? "");
  if (str.length <= limit) return str;
  return `${str.slice(0, limit)}\n... [truncated ${str.length - limit} chars]`;
}

export function extractToolPreview(tc) {
  try {
    const args = typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments ?? {};
    if (tc.name === "Write") return shorten(args.file_path ?? "", 80);
    if (tc.name === "Edit") return shorten(args.file_path ?? "", 80);
    if (tc.name === "Read") return shorten(args.file_path ?? "", 80);
    if (tc.name === "Glob") return shorten(args.pattern ?? "", 80);
    if (tc.name === "Grep") return shorten(args.pattern ?? "", 80);
    return "";
  } catch {
    return "";
  }
}

export function describeToolPhase(toolName) {
  switch (toolName) {
    case "Write":
    case "Edit":
      return "editing";
    case "Read":
    case "Glob":
    case "Grep":
      return "investigating";
    default:
      return "running";
  }
}

function emitProgress(onProgress, message, phase) {
  if (!onProgress) return;
  onProgress({ message, phase, stderrMessage: message });
}

export async function getEndpointAvailability(endpoint = DEFAULT_ENDPOINT) {
  try {
    const res = await fetch(`${endpoint}/models`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      return { available: true, detail: `${endpoint}/models reachable` };
    }
    return { available: false, detail: `HTTP ${res.status} from ${endpoint}/models` };
  } catch (err) {
    return { available: false, detail: err?.message ?? String(err) };
  }
}

export async function listAvailableModels(endpoint = DEFAULT_ENDPOINT, apiKey = null) {
  try {
    const res = await fetch(`${endpoint}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return { ok: false, models: [], detail: `HTTP ${res.status} from ${endpoint}/models` };
    const data = await res.json();
    const raw = data?.data ?? data?.models ?? [];
    const models = raw
      .map((entry) => (typeof entry === "string" ? entry : entry.id ?? entry.name ?? ""))
      .filter(Boolean);
    return { ok: true, models, detail: `${models.length} model(s) available` };
  } catch (err) {
    return { ok: false, models: [], detail: err?.message ?? String(err) };
  }
}

export async function getModelAvailable(endpoint = DEFAULT_ENDPOINT, model = null) {
  if (!model) {
    return { available: false, loaded: false, detail: "no model specified (pass --model or set APPRENTICE_MODEL)" };
  }
  try {
    const res = await fetch(`${endpoint}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      return { available: false, loaded: false, detail: `HTTP ${res.status} from ${endpoint}/models` };
    }
    const data = await res.json();
    const list = data?.data ?? data?.models ?? [];
    const found = list.some((entry) => {
      const id = typeof entry === "string" ? entry : entry.id ?? entry.name ?? "";
      return id === model;
    });
    return {
      available: true,
      loaded: found,
      detail: found ? `${model} is loaded at ${endpoint}` : `${model} not loaded at ${endpoint}`
    };
  } catch (err) {
    return { available: false, loaded: false, detail: err?.message ?? String(err) };
  }
}

function authHeaders(apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function* iterateSseLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
      buffer = buffer.slice(newlineIdx + 1);
      if (line) yield line;
    }
  }
  const tail = buffer.trim();
  if (tail) yield tail;
}

function createDeltaAccumulator() {
  const toolCallsByIndex = new Map();
  let content = "";
  let reasoning = "";
  let role = "assistant";

  return {
    apply(delta) {
      if (!delta) return;
      if (typeof delta.role === "string") role = delta.role;
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      if (typeof delta.reasoning === "string") reasoning += delta.reasoning;

      const deltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const tcDelta of deltas) {
        const idx = typeof tcDelta.index === "number" ? tcDelta.index : toolCallsByIndex.size;
        const acc = toolCallsByIndex.get(idx) ?? { id: null, name: null, arguments: "" };
        if (tcDelta.id) acc.id = tcDelta.id;
        if (tcDelta.function?.name) acc.name = tcDelta.function.name;
        if (typeof tcDelta.function?.arguments === "string") {
          acc.arguments += tcDelta.function.arguments;
        }
        toolCallsByIndex.set(idx, acc);
      }
    },
    finalize() {
      const toolCalls = [...toolCallsByIndex.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc], i) => ({
          id: tc.id ?? `call_${i}`,
          name: tc.name ?? "unknown",
          arguments: tc.arguments || "{}"
        }));

      // Some models (Gemma 4 with thinking mode, DeepSeek-R1, QwQ, certain
      // llama.cpp builds) emit chain-of-thought as <think>...</think> blocks
      // inside the assistant content stream instead of the reasoning_content
      // field. Extract those so the final "content" is just the user-facing
      // response.
      let cleanedContent = content;
      let extractedReasoning = reasoning;
      const thinkRegex = /<think>([\s\S]*?)<\/think>\s*/g;
      const matches = [...content.matchAll(thinkRegex)];
      if (matches.length > 0) {
        for (const match of matches) {
          const block = match[1].trim();
          if (block) {
            extractedReasoning += (extractedReasoning ? "\n" : "") + block;
          }
        }
        cleanedContent = content.replace(thinkRegex, "").trim();
      }

      return { role, content: cleanedContent, reasoning: extractedReasoning, toolCalls };
    }
  };
}

async function streamChatCompletion({ endpoint, apiKey, model, messages, tools, signal, state }) {
  const body = { model, messages, stream: true };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Chat completion failed (${res.status}): ${errBody.slice(0, 400)}`);
  }

  const accumulator = createDeltaAccumulator();
  let sawData = false;

  for await (const line of iterateSseLines(res)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") break;

    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      state.errors.push(`SSE parse error: ${shorten(payload, 120)}`);
      continue;
    }
    sawData = true;

    const delta = chunk?.choices?.[0]?.delta;
    if (delta) accumulator.apply(delta);

    if (typeof delta?.content === "string" && delta.content.length) {
      emitProgress(state.onProgress, `response: ${shorten(delta.content, 96)}`, "finalizing");
    }
  }

  if (!sawData) {
    throw new Error(`Empty stream from ${endpoint}/chat/completions (is the model "${model}" loaded?)`);
  }

  return accumulator.finalize();
}

function buildAssistantMessage(finalized) {
  const msg = { role: "assistant", content: finalized.content || null };
  if (finalized.toolCalls.length) {
    msg.tool_calls = finalized.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments }
    }));
  }
  return msg;
}

function finishResult(status, state, runtime, extras = {}) {
  return {
    status,
    finalMessage: state.finalTexts.join("\n"),
    steps: state.steps,
    stepCount: state.stepCount,
    touchedFiles: [...runtime.touchedFiles],
    thinkingBlocks: state.thinkingBlocks,
    errors: state.errors,
    stderr: extras.stderr ?? ""
  };
}

export async function runApprenticeTask(options) {
  const endpoint = options.endpoint || DEFAULT_ENDPOINT;
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? null;
  const model = options.model || process.env.APPRENTICE_MODEL || null;

  if (!model) {
    throw new Error("No model specified. Pass --model <name> or set APPRENTICE_MODEL.");
  }

  const maxSteps = Number.isFinite(options.maxSteps) && options.maxSteps > 0
    ? Number(options.maxSteps)
    : DEFAULT_MAX_STEPS;
  const cwd = options.cwd || process.cwd();
  const systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;

  const runtime = createToolRuntime({ cwd });
  const tools = TOOL_SCHEMAS;

  const messages = [{ role: "system", content: systemPrompt }];
  if (options.prompt) messages.push({ role: "user", content: options.prompt });

  const state = {
    steps: [],
    stepCount: 0,
    finalTexts: [],
    thinkingBlocks: [],
    errors: [],
    onProgress: options.onProgress ?? null
  };

  const controller = new AbortController();
  let aborted = false;
  const onSignal = () => { aborted = true; controller.abort(); };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  try {
    for (let turn = 0; turn < maxSteps; turn++) {
      const finalized = await streamChatCompletion({
        endpoint, apiKey, model, messages, tools,
        signal: controller.signal, state
      });

      if (finalized.reasoning) {
        state.thinkingBlocks.push(finalized.reasoning);
        emitProgress(state.onProgress, `Thinking: ${shorten(finalized.reasoning, 96)}`, "thinking");
      }

      const assistantMsg = buildAssistantMessage(finalized);
      messages.push(assistantMsg);

      if (!finalized.toolCalls.length) {
        if (finalized.content) state.finalTexts.push(finalized.content);
        return finishResult(0, state, runtime);
      }

      const currentThink = finalized.reasoning || null;
      for (const tc of finalized.toolCalls) {
        state.stepCount++;
        const preview = extractToolPreview(tc);
        emitProgress(
          state.onProgress,
          `Step ${state.stepCount}: ${tc.name} ${preview}`.trim(),
          describeToolPhase(tc.name)
        );

        const result = await runtime.executeTool(tc);
        state.steps.push({
          think: currentThink,
          toolCall: { id: tc.id, name: tc.name, arguments: tc.arguments },
          toolResult: truncatePreservingStructure(result.content, 2500)
        });
        if (result.error) state.errors.push(`${tc.name}: ${result.error}`);

        emitProgress(
          state.onProgress,
          `${tc.name} ${result.error ? "failed" : "completed"}`,
          describeToolPhase(tc.name)
        );

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result.content
        });
      }
    }

    state.errors.push(`Hit max-steps limit (${maxSteps}) without completing.`);
    return finishResult(1, state, runtime);
  } catch (err) {
    const message = err?.message ?? String(err);
    state.errors.push(message);
    return finishResult(aborted ? 130 : 1, state, runtime, { stderr: err?.stack ?? message });
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}
