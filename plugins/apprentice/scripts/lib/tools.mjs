import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { unifiedLineDiff } from "./diff.mjs";
import { runCommand } from "./process.mjs";

const MAX_TOOL_OUTPUT = 50_000;
const DEFAULT_READ_LIMIT = 2000;

const HOME = os.homedir();

const DANGEROUS_WRITE_PREFIXES = [
  "/etc", "/boot", "/sys", "/proc", "/dev", "/bin", "/sbin", "/usr/bin", "/usr/sbin",
  path.join(HOME, ".ssh"),
  path.join(HOME, ".gnupg"),
  path.join(HOME, ".aws"),
  path.join(HOME, ".config/gcloud"),
  path.join(HOME, ".docker"),
  path.join(HOME, ".bashrc"),
  path.join(HOME, ".zshrc"),
  path.join(HOME, ".profile"),
  path.join(HOME, ".gitconfig")
];

const SENSITIVE_READ_PREFIXES = [
  path.join(HOME, ".ssh"),
  path.join(HOME, ".gnupg"),
  path.join(HOME, ".aws", "credentials"),
  "/etc/shadow",
  "/etc/sudoers"
];

const PROTECTED_BASENAME_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /^authorized_keys$/
];

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "Read",
      description:
        "Read a file's contents. Paths must resolve inside the workspace (no paths outside cwd). Pass offset (1-indexed start line) and limit (max lines) to slice large files. Returned lines are prefixed with their line number.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Workspace-relative or absolute path inside cwd" },
          offset: { type: "integer", description: "1-indexed start line" },
          limit: { type: "integer", description: "Maximum number of lines to return" }
        },
        required: ["file_path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "Write",
      description:
        "Write content to a file, overwriting if it exists. Parent directories are created automatically. Paths must be inside the workspace. Prefer Edit when modifying an existing file.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          content: { type: "string" }
        },
        required: ["file_path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "Edit",
      description:
        "Replace old_string with new_string in a file. You must Read the file first in this task. old_string must match exactly once unless replace_all is true. Smart/curly quote differences are handled automatically.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: {
            type: "boolean",
            description: "Replace every occurrence instead of requiring a unique match"
          }
        },
        required: ["file_path", "old_string", "new_string"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "Glob",
      description: "List files matching a glob pattern (e.g. '**/*.ts') inside the workspace. Uses ripgrep under the hood.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "Base directory inside workspace; defaults to cwd" }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "Grep",
      description:
        "Search file contents with a regex (ripgrep). output_mode controls what is returned: 'content' (matching lines with line numbers), 'files_with_matches', or 'count'. Paths must be inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string", description: "Glob filter, e.g. '*.js'" },
          output_mode: {
            type: "string",
            enum: ["content", "files_with_matches", "count"]
          },
          case_insensitive: { type: "boolean" },
          context: { type: "integer", description: "Lines of context around each match" }
        },
        required: ["pattern"]
      }
    }
  }
];

function normalizeQuotes(str) {
  return str
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201F]/g, '"');
}

function findActualOldString(haystack, needle) {
  if (haystack.includes(needle)) return needle;
  const normalizedHaystack = normalizeQuotes(haystack);
  const normalizedNeedle = normalizeQuotes(needle);
  const idx = normalizedHaystack.indexOf(normalizedNeedle);
  if (idx === -1) return null;
  return haystack.substring(idx, idx + needle.length);
}

function pathStartsWith(candidate, prefix) {
  if (!prefix) return false;
  if (candidate === prefix) return true;
  return candidate.startsWith(prefix + path.sep);
}

function resolveInsideWorkspace(cwd, filePath) {
  if (!filePath) throw new Error("file_path is required");
  const resolvedCwd = path.resolve(cwd);
  const resolved = path.resolve(resolvedCwd, filePath);
  if (resolved !== resolvedCwd && !resolved.startsWith(resolvedCwd + path.sep)) {
    throw new Error(`Path escapes workspace: ${filePath} (workspace: ${resolvedCwd})`);
  }
  return resolved;
}

function dangerousWritePrefix(resolved) {
  return DANGEROUS_WRITE_PREFIXES.find((p) => pathStartsWith(resolved, p)) ?? null;
}

function sensitiveReadPrefix(resolved) {
  return SENSITIVE_READ_PREFIXES.find((p) => pathStartsWith(resolved, p)) ?? null;
}

function isProtectedBasename(resolved) {
  const base = path.basename(resolved);
  return PROTECTED_BASENAME_PATTERNS.some((re) => re.test(base));
}

function truncate(text, limit = MAX_TOOL_OUTPUT) {
  const str = String(text ?? "");
  if (str.length <= limit) return str;
  return `${str.slice(0, limit)}\n... [truncated ${str.length - limit} chars]`;
}

function recordFileSignature(readFiles, target, stat) {
  readFiles.set(target, { mtimeMs: stat.mtimeMs, size: stat.size });
}

const handlers = {
  async Read(args, ctx) {
    const target = resolveInsideWorkspace(ctx.cwd, args.file_path);

    const sensitive = sensitiveReadPrefix(target);
    if (sensitive) {
      return { content: "", error: `Read blocked — sensitive path: ${sensitive}` };
    }

    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      return { content: "", error: `Not a file (got directory): ${target}` };
    }
    if (!stat.isFile()) {
      return { content: "", error: `Not a regular file: ${target}` };
    }

    const raw = await fs.readFile(target, "utf8");
    const lines = raw.split("\n");
    const hasSlice = Number.isInteger(args.offset) || Number.isInteger(args.limit);
    const offset = Math.max(0, (Number.isInteger(args.offset) ? args.offset : 1) - 1);
    const limit = Number.isInteger(args.limit) ? Math.max(0, args.limit) : DEFAULT_READ_LIMIT;
    const sliced = hasSlice ? lines.slice(offset, offset + limit) : lines.slice(0, DEFAULT_READ_LIMIT);
    const startLine = hasSlice ? offset + 1 : 1;
    const numbered = sliced.map((line, i) => `${startLine + i}\t${line}`).join("\n");

    recordFileSignature(ctx.readFiles, target, stat);
    return { content: truncate(numbered), error: null };
  },

  async Write(args, ctx) {
    const target = resolveInsideWorkspace(ctx.cwd, args.file_path);

    const danger = dangerousWritePrefix(target);
    if (danger) return { content: "", error: `Write blocked — protected path: ${danger}` };
    if (isProtectedBasename(target)) {
      return {
        content: "",
        error: `Write blocked — protected filename may contain secrets: ${path.basename(target)}`
      };
    }

    let existed = false;
    let previousContent = "";
    try {
      previousContent = await fs.readFile(target, "utf8");
      existed = true;
    } catch {}

    const newContent = args.content ?? "";

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, newContent, "utf8");

    const stat = await fs.stat(target);
    recordFileSignature(ctx.readFiles, target, stat);
    ctx.touchedFiles.add(target);

    if (!existed) {
      const lineCount = newContent ? newContent.split("\n").length : 0;
      return { content: `Wrote ${target} (${lineCount} lines, new file)`, error: null };
    }

    // Overwrite of existing file — attach a diff so both the apprentice and
    // the senior reviewer can see what actually changed.
    const diff = unifiedLineDiff(previousContent, newContent, { contextLines: 2, maxLines: 30 });
    const header = `Overwrote ${target}`;
    return { content: diff ? `${header}\n${diff}` : `${header} (content unchanged)`, error: null };
  },

  async Edit(args, ctx) {
    const target = resolveInsideWorkspace(ctx.cwd, args.file_path);

    const danger = dangerousWritePrefix(target);
    if (danger) return { content: "", error: `Edit blocked — protected path: ${danger}` };
    if (isProtectedBasename(target)) {
      return {
        content: "",
        error: `Edit blocked — protected filename may contain secrets: ${path.basename(target)}`
      };
    }

    const readMeta = ctx.readFiles.get(target);
    if (!readMeta) {
      return {
        content: "",
        error: `You must Read ${target} in this task before editing it.`
      };
    }

    const stat = await fs.stat(target);
    if (stat.mtimeMs !== readMeta.mtimeMs || stat.size !== readMeta.size) {
      ctx.readFiles.delete(target);
      return {
        content: "",
        error: `${target} changed on disk since last Read. Re-Read it before editing.`
      };
    }

    const original = await fs.readFile(target, "utf8");
    const oldStringRaw = args.old_string ?? "";
    const newString = args.new_string ?? "";

    if (!oldStringRaw) {
      return { content: "", error: "old_string must not be empty (use Write for new files)" };
    }
    if (oldStringRaw === newString) {
      return { content: "", error: "old_string and new_string are identical — no-op" };
    }

    const oldString = findActualOldString(original, oldStringRaw);
    if (!oldString) {
      return { content: "", error: `old_string not found in ${target}` };
    }

    const occurrences = original.split(oldString).length - 1;

    if (args.replace_all) {
      const updated = original.split(oldString).join(newString);
      await fs.writeFile(target, updated, "utf8");
      const newStat = await fs.stat(target);
      recordFileSignature(ctx.readFiles, target, newStat);
      ctx.touchedFiles.add(target);
      return { content: `Replaced ${occurrences} occurrences in ${target}`, error: null };
    }

    if (occurrences > 1) {
      return {
        content: "",
        error: `old_string matches ${occurrences} times in ${target}; add surrounding context for a unique match or pass replace_all=true`
      };
    }

    const updated = original.replace(oldString, newString);
    await fs.writeFile(target, updated, "utf8");
    const newStat = await fs.stat(target);
    recordFileSignature(ctx.readFiles, target, newStat);
    ctx.touchedFiles.add(target);
    return { content: `Edited ${target}`, error: null };
  },

  async Glob(args, ctx) {
    const base = args.path ? resolveInsideWorkspace(ctx.cwd, args.path) : ctx.cwd;
    const result = runCommand("rg", ["--files", "-g", args.pattern, "--no-messages"], { cwd: base });
    if (result.error?.code === "ENOENT") {
      return { content: "", error: "ripgrep (rg) not installed; cannot run Glob" };
    }
    const out = result.stdout.trim();
    if (!out) return { content: "(no matches)", error: null };
    return { content: truncate(out), error: null };
  },

  async Grep(args, ctx) {
    const rgArgs = [];
    if (args.case_insensitive) rgArgs.push("-i");

    const mode = args.output_mode || "content";
    if (mode === "files_with_matches") rgArgs.push("-l");
    else if (mode === "count") rgArgs.push("-c");
    else rgArgs.push("-n");

    if (Number.isInteger(args.context)) rgArgs.push("-C", String(args.context));
    if (args.glob) rgArgs.push("-g", args.glob);
    rgArgs.push("--", args.pattern);

    const searchBase = args.path ? resolveInsideWorkspace(ctx.cwd, args.path) : ctx.cwd;
    rgArgs.push(searchBase);

    const result = runCommand("rg", rgArgs, { cwd: ctx.cwd });
    if (result.error?.code === "ENOENT") {
      return { content: "", error: "ripgrep (rg) not installed; cannot run Grep" };
    }
    if (result.status === 1 && !result.stdout.trim()) {
      return { content: "(no matches)", error: null };
    }
    if (result.status !== 0 && result.status !== 1) {
      return {
        content: truncate(result.stdout),
        error: result.stderr.trim() || `rg exited with ${result.status}`
      };
    }
    return { content: truncate(result.stdout), error: null };
  }
};

export function createToolRuntime({ cwd }) {
  const touchedFiles = new Set();
  const readFiles = new Map();
  const ctx = { cwd: path.resolve(cwd), touchedFiles, readFiles };

  return {
    touchedFiles,
    async executeTool(tc) {
      const handler = handlers[tc.name];
      if (!handler) {
        return { content: "", error: `Unknown tool: ${tc.name}` };
      }

      let parsedArgs = {};
      try {
        parsedArgs = typeof tc.arguments === "string"
          ? (tc.arguments.trim() ? JSON.parse(tc.arguments) : {})
          : (tc.arguments ?? {});
      } catch (err) {
        return { content: "", error: `Invalid JSON arguments for ${tc.name}: ${err.message}` };
      }

      try {
        return await handler(parsedArgs, ctx);
      } catch (err) {
        return { content: "", error: err?.message ?? String(err) };
      }
    }
  };
}
