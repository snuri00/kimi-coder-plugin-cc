#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import {
  DEFAULT_ENDPOINT,
  getEndpointAvailability,
  getModelAvailable,
  listAvailableModels,
  runApprenticeTask
} from "./lib/llm.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";
import { generateJobId, getConfig, setConfig, upsertJob, writeJobFile } from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob
} from "./lib/job-control.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/apprentice.mjs setup [--endpoint <url>] [--model <name>] [--json]",
      "  node scripts/apprentice.mjs task [--background] [--model <name>] [--endpoint <url>] [--api-key <key>] [--max-steps <n>] [prompt]",
      "  node scripts/apprentice.mjs config <get|set|unset> [key] [value] [--json]",
      "  node scripts/apprentice.mjs status [job-id] [--all] [--json]",
      "  node scripts/apprentice.mjs result [job-id] [--json]",
      "  node scripts/apprentice.mjs cancel [job-id] [--json]",
      "",
      "Config keys (per-workspace): model, endpoint",
      "Resolution order for task: --flag > env var > workspace config > default/auto-detect.",
      "",
      "Environment:",
      "  APPRENTICE_ENDPOINT   Default OpenAI-compatible endpoint (falls back to http://localhost:11434/v1)",
      "  APPRENTICE_MODEL      Default model id (e.g. gemma4:26b, qwen2.5-coder:14b)",
      "  OPENAI_API_KEY        Optional API key (for proxies / vLLM / LiteLLM)"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) return [];
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((v) => v.trim())
    .find(Boolean);
  return line ?? fallback;
}

// ─── config resolution ──────────────────────────────────────────────────────

const ALLOWED_CONFIG_KEYS = ["model", "endpoint"];

function resolveModel(options, cwd) {
  return (
    options.model ||
    process.env.APPRENTICE_MODEL ||
    getConfig(cwd).model ||
    null
  );
}

function resolveEndpoint(options, cwd) {
  return (
    options.endpoint ||
    process.env.APPRENTICE_ENDPOINT ||
    getConfig(cwd).endpoint ||
    DEFAULT_ENDPOINT
  );
}

function renderConfig(config) {
  const keys = ALLOWED_CONFIG_KEYS;
  const lines = ["# Apprentice Config\n"];
  for (const key of keys) {
    const value = config[key];
    lines.push(`- **${key}:** ${value ? value : "(unset)"}`);
  }
  return lines.join("\n") + "\n";
}

function handleConfig(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const [action, key, ...valueParts] = positionals;
  const value = valueParts.join(" ");

  if (!action || action === "get") {
    const config = getConfig(cwd);
    if (key) {
      const payload = { [key]: config[key] ?? null };
      outputResult(options.json ? payload : `${key} = ${config[key] ?? "(unset)"}\n`, options.json);
      return;
    }
    outputResult(options.json ? config : renderConfig(config), options.json);
    return;
  }

  if (action === "set") {
    if (!key) throw new Error("Usage: config set <key> <value>");
    if (!ALLOWED_CONFIG_KEYS.includes(key)) {
      throw new Error(`Unknown config key "${key}". Allowed: ${ALLOWED_CONFIG_KEYS.join(", ")}`);
    }
    if (!value) throw new Error(`Missing value for config set ${key}. Pass a non-empty string.`);
    setConfig(cwd, key, value);
    outputResult(options.json ? { [key]: value } : `Set ${key} = ${value}\n`, options.json);
    return;
  }

  if (action === "unset") {
    if (!key) throw new Error("Usage: config unset <key>");
    if (!ALLOWED_CONFIG_KEYS.includes(key)) {
      throw new Error(`Unknown config key "${key}". Allowed: ${ALLOWED_CONFIG_KEYS.join(", ")}`);
    }
    setConfig(cwd, key, null);
    outputResult(options.json ? { [key]: null } : `Unset ${key}\n`, options.json);
    return;
  }

  throw new Error(`Unknown config action "${action}". Use get, set, or unset.`);
}

// ─── setup ───────────────────────────────────────────────────────────────────

async function buildSetupReport({ endpoint, model }) {
  const nodeStatus = binaryAvailable("node", ["--version"]);
  const rgStatus = binaryAvailable("rg", ["--version"]);
  const endpointStatus = await getEndpointAvailability(endpoint);
  const modelStatus = endpointStatus.available
    ? await getModelAvailable(endpoint, model)
    : { available: false, loaded: false, detail: "endpoint unreachable" };

  const nextSteps = [];
  if (!endpointStatus.available) {
    nextSteps.push(
      `Start an OpenAI-compatible server at ${endpoint} (e.g. \`ollama serve\` or \`llama-server --port 8080 --host 0.0.0.0 -cb\`).`
    );
  }
  if (endpointStatus.available && !model) {
    nextSteps.push("Pass a model id via --model or set APPRENTICE_MODEL (e.g. gemma4:26b, qwen2.5-coder:14b).");
  }
  if (endpointStatus.available && model && !modelStatus.loaded) {
    nextSteps.push(`Pull or load the model: \`ollama pull ${model}\` (or equivalent for your backend).`);
  }
  if (!rgStatus.available) {
    nextSteps.push("Install ripgrep (`rg`) — required for Glob/Grep tools.");
  }

  return {
    ready: endpointStatus.available && rgStatus.available && (!model || modelStatus.loaded),
    endpoint,
    model,
    node: nodeStatus,
    ripgrep: rgStatus,
    endpointStatus,
    modelStatus,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "endpoint", "model"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const endpoint = resolveEndpoint(options, cwd);
  const model = resolveModel(options, cwd);
  const report = await buildSetupReport({ endpoint, model });
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

// ─── task ────────────────────────────────────────────────────────────────────

function buildTaskJob(workspaceRoot, title, summary) {
  return createJobRecord({
    id: generateJobId("apprentice"),
    kind: "task",
    kindLabel: "code",
    title,
    workspaceRoot,
    jobClass: "task",
    summary
  });
}

async function executeTaskRun(request) {
  const result = await runApprenticeTask({
    cwd: request.cwd,
    prompt: request.prompt,
    endpoint: request.endpoint,
    apiKey: request.apiKey,
    model: request.model,
    maxSteps: request.maxSteps,
    systemPrompt: request.systemPrompt,
    onProgress: request.onProgress
  });

  const rendered = renderTaskResult(result, {
    title: request.title ?? "Apprentice Task",
    jobId: request.jobId ?? null
  });

  return {
    exitStatus: result.status,
    sessionId: null,
    payload: {
      status: result.status,
      finalMessage: result.finalMessage,
      steps: result.steps,
      stepCount: result.stepCount,
      touchedFiles: result.touchedFiles,
      thinkingBlocks: result.thinkingBlocks,
      errors: result.errors
    },
    rendered,
    summary: firstMeaningfulLine(result.finalMessage, "Apprentice task finished."),
    jobTitle: request.title ?? "Apprentice Task",
    jobClass: "task"
  };
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "apprentice.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [
      "model",
      "endpoint",
      "api-key",
      "max-steps",
      "cwd",
      "prompt-file",
      "system-prompt-file"
    ],
    booleanOptions: ["json", "background"],
    aliasMap: { m: "model" }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const endpoint = resolveEndpoint(options, cwd);
  const apiKey = options["api-key"] || process.env.OPENAI_API_KEY || null;
  const maxSteps = options["max-steps"] ? Number(options["max-steps"]) : null;

  let model = resolveModel(options, cwd);
  if (!model) {
    const listing = await listAvailableModels(endpoint, apiKey);
    if (!listing.ok) {
      throw new Error(
        `No model configured and endpoint check failed: ${listing.detail}.\n` +
        "Pass --model <name>, set APPRENTICE_MODEL, or run:\n" +
        "  /apprentice:config set model <name>"
      );
    }
    if (listing.models.length === 0) {
      throw new Error(
        `No models available at ${endpoint}. Pull one first (e.g. \`ollama pull gemma4:26b\`).`
      );
    }
    if (listing.models.length === 1) {
      model = listing.models[0];
      process.stderr.write(`[apprentice] auto-detected model: ${model}\n`);
    } else {
      throw new Error(
        `No model specified and multiple are available. Pick one:\n  - ` +
        listing.models.join("\n  - ") +
        "\n\nPass --model <name> or run:\n  /apprentice:config set model <name>"
      );
    }
  }

  let systemPrompt = null;
  if (options["system-prompt-file"]) {
    systemPrompt = fs.readFileSync(path.resolve(cwd, options["system-prompt-file"]), "utf8");
  }

  let prompt;
  if (options["prompt-file"]) {
    prompt = fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  } else {
    prompt = positionals.join(" ") || readStdinIfPiped();
  }

  if (!prompt) {
    throw new Error("Provide a prompt, --prompt-file, or piped stdin.");
  }

  const title = "Apprentice Task";
  const summary = shorten(prompt, 80);
  const job = buildTaskJob(workspaceRoot, title, summary);

  if (options.background) {
    const logFile = createJobLogFile(workspaceRoot, job.id, title);
    appendLogLine(logFile, "Queued for background execution.");

    const child = spawnDetachedTaskWorker(cwd, job.id);
    const queuedRecord = {
      ...job,
      status: "queued",
      phase: "queued",
      pid: child.pid ?? null,
      logFile,
      request: { cwd, prompt, model, endpoint, apiKey, maxSteps, systemPrompt, title }
    };
    writeJobFile(workspaceRoot, job.id, queuedRecord);
    upsertJob(workspaceRoot, queuedRecord);

    const output = `${title} started in the background as ${job.id}. Check /apprentice:status ${job.id} for progress.\n`;
    outputResult(options.json ? { jobId: job.id, status: "queued", title, summary } : output, options.json);
    return;
  }

  const logFile = createJobLogFile(workspaceRoot, job.id, title);
  const progress = createProgressReporter({
    stderr: !options.json,
    logFile,
    onEvent: createJobProgressUpdater(workspaceRoot, job.id)
  });

  const execution = await runTrackedJob(
    { ...job, logFile },
    () =>
      executeTaskRun({
        cwd,
        prompt,
        model,
        endpoint,
        apiKey,
        maxSteps,
        systemPrompt,
        title,
        jobId: job.id,
        onProgress: progress
      }),
    { logFile }
  );

  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const logFile = storedJob.logFile ?? createJobLogFile(workspaceRoot, storedJob.id, storedJob.title);
  const progress = createProgressReporter({
    logFile,
    onEvent: createJobProgressUpdater(workspaceRoot, storedJob.id)
  });

  await runTrackedJob(
    { ...storedJob, workspaceRoot, logFile },
    () =>
      executeTaskRun({
        ...request,
        jobId: storedJob.id,
        onProgress: progress
      }),
    { logFile }
  );
}

// ─── status ──────────────────────────────────────────────────────────────────

function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";

  if (reference) {
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    outputResult(options.json ? snapshot : renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

// ─── result ──────────────────────────────────────────────────────────────────

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = { job, storedJob };

  outputResult(options.json ? payload : renderStoredJobResult(job, storedJob), options.json);
}

// ─── cancel ──────────────────────────────────────────────────────────────────

function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference);

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, nextJob);
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title
  };

  outputResult(options.json ? payload : renderCancelReport(nextJob), options.json);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "config":
      handleConfig(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
