// bb-plugin-auto-compact — compact a thread's context window automatically
// when usage reaches a configurable percentage.
//
// How it works: BB reports per-thread context usage on the thread timeline
// (`contextWindowUsage`: used tokens vs. model window). When a thread goes
// idle or fails — exactly the states where BB allows compaction — this plugin
// reads that usage and compacts once it meets the threshold. Hermes ACP does
// not expose BB-native transcript compaction, so an explicit manual request
// can materialize a small successor thread instead of falsely claiming that
// Hermes' provider-local /compress changed BB's transcript.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Minimum time between two auto-compactions of the same thread. */
const COOLDOWN_MS = 15 * 60_000;
const LAST_COMPACT_KV_PREFIX = "last-compact:";
const UNSUPPORTED_KV_PREFIX = "unsupported-compact:";
const HERMES_PROVIDER_ID = "acp-hermes-agent";
const HERMES_SUCCESSOR_MAX_CHARS = 24_000;
const HERMES_PROMPT_LIMIT = 200;

/** Percentage of `window` consumed by `used`, or null when unmeasurable. */
export function usagePercent(
  usedTokens: number,
  modelContextWindow: number,
): number | null {
  if (
    !Number.isFinite(usedTokens) ||
    !Number.isFinite(modelContextWindow) ||
    modelContextWindow <= 0 ||
    usedTokens < 0
  ) {
    return null;
  }
  return (usedTokens / modelContextWindow) * 100;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 200) || "Unknown error.";
}

/**
 * True when BB reports the thread's provider cannot compact at all (some
 * ACP bridges throw "<provider> does not support manual compaction").
 */
function isUnsupportedCompaction(error: unknown): boolean {
  return /does not support .*compaction/i.test(errorMessage(error));
}

function isHermesProvider(providerId: string | null | undefined): boolean {
  return providerId === HERMES_PROVIDER_ID;
}

type TextInput = { type: "text"; text: string };

function inputText(input: unknown): string {
  if (!Array.isArray(input)) return "";
  return input
    .filter((item): item is TextInput =>
      typeof item === "object" && item !== null &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function clip(text: string, maxChars: number): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 40))}\n[… clipped …]`;
}

/**
 * Build a bounded, deterministic continuation record. This is intentionally
 * not an LLM summary: a 500k-token Hermes thread must be made smaller before
 * another model request can be trusted to summarize it.
 */
export function buildHermesSuccessorSeed(args: {
  sourceThreadId: string;
  providerId: string;
  prompts: readonly { input?: unknown }[];
  latestOutput?: string | null;
}): string {
  const prompts = args.prompts
    .map((entry) => inputText(entry.input))
    .filter(Boolean);
  const selected = prompts.length <= 10
    ? prompts
    : [...prompts.slice(0, 2), "[… earlier prompts elided …]", ...prompts.slice(-8)];
  const promptBudget = Math.max(2_000, HERMES_SUCCESSOR_MAX_CHARS - 8_000);
  const promptText = clip(
    selected.map((text, index) => `Prompt ${index + 1}:\n${clip(text, 2_000)}`).join("\n\n"),
    promptBudget,
  );
  const output = clip(args.latestOutput ?? "", 7_000);
  return clip(
    [
      "# Compacted Hermes continuation",
      `Original BB thread: ${args.sourceThreadId}`,
      `Provider: ${args.providerId}`,
      "",
      "This is a deterministic continuation seed created by BB. The original thread was preserved separately; do not assume omitted tool output or hidden reasoning is present here.",
      "",
      promptText ? `Recent user prompts:\n${promptText}` : "Recent user prompts: unavailable",
      "",
      output ? `Latest assistant output:\n${output}` : "Latest assistant output: unavailable",
      "",
      "Continue the task from this record. Re-open files or re-check claims when the omitted transcript matters.",
    ].join("\n"),
    HERMES_SUCCESSOR_MAX_CHARS,
  );
}

// RPC contract for the thread-header Compact button (app.tsx imports only
// this contract's type; the backend module is erased from the bundle).
const usageSchema = z.object({
  percent: z.number().nullable(),
  usedTokens: z.number().nullable(),
  modelContextWindow: z.number().nullable(),
  thresholdPercent: z.number(),
});
export const rpcContract = defineRpcContract({
  compact_now: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ result: z.string() }),
  },
  usage: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: usageSchema,
  },
  compact_hermes: {
    input: z.object({ threadId: z.string().min(1), archiveSource: z.boolean().optional() }).strict(),
    output: z.object({ sourceThreadId: z.string(), successorThreadId: z.string(), seedChars: z.number() }).strict(),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Auto-compact threads",
      description:
        "When on, idle or failed threads are compacted once context usage reaches the threshold.",
      default: true,
    },
    thresholdPercent: {
      type: "select",
      label: "Compact when context usage reaches",
      description:
        "Percentage of the model's context window at which a thread is compacted.",
      options: ["70", "75", "80", "85", "90", "95"],
      default: "80",
    },
  });
  let cached = await settings.get();
  settings.onChange((next) => {
    cached = next;
  });

  // Threads currently being compacted; prevents overlapping compactions of
  // the same thread from concurrent idle/failed events.
  const inFlight = new Set<string>();

  async function readUsage(threadId: string): Promise<{
    percent: number | null;
    usedTokens: number | null;
    modelContextWindow: number | null;
  }> {
    try {
      const timeline = await bb.sdk.threads.timeline({ threadId });
      const used = timeline.contextWindowUsage?.usedTokens;
      const window = timeline.contextWindowUsage?.modelContextWindow;
      return {
        percent:
          used === undefined || window === undefined
            ? null
            : usagePercent(used, window),
        usedTokens: used ?? null,
        modelContextWindow: window ?? null,
      };
    } catch (error) {
      bb.log.warn(
        `Auto-compact: could not read usage for thread ${threadId}: ${errorMessage(error)}`,
      );
      return { percent: null, usedTokens: null, modelContextWindow: null };
    }
  }

  async function compactThread(
    threadId: string,
  ): Promise<void> {
    await bb.sdk.threads.compact({ threadId });
  }

  async function resolveProviderId(
    threadId: string,
  ): Promise<string | null | undefined> {
    try {
      return (await bb.sdk.threads.get({ threadId })).providerId;
    } catch (error) {
      // Older BB test hosts and SDK shims may not expose threads.get. Native
      // compaction remains the safe fallback in that case.
      bb.log.debug?.(
        `Auto-compact: could not resolve provider for ${threadId}: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  async function materializeHermesSuccessor(
    threadId: string,
    archiveSource = false,
  ): Promise<{ sourceThreadId: string; successorThreadId: string; seedChars: number }> {
    const source = await bb.sdk.threads.get({ threadId });
    if (!isHermesProvider(source.providerId)) {
      throw new Error("successor compaction is only available for Hermes ACP threads");
    }
    const displayStatus = source.runtime.displayStatus;
    if (displayStatus !== "idle" && displayStatus !== "error") {
      throw new Error(`thread must be idle or errored (currently ${displayStatus})`);
    }
    const prompts = await bb.sdk.threads.promptHistory({
      threadId,
      limit: String(HERMES_PROMPT_LIMIT),
    });
    const latest = await bb.sdk.threads.output({ threadId });
    const latestOutput = typeof latest === "string"
      ? latest
      : typeof latest?.output === "string" ? latest.output : null;
    const seed = buildHermesSuccessorSeed({
      sourceThreadId: threadId,
      providerId: source.providerId,
      prompts,
      latestOutput,
    });
    const successor = await bb.sdk.threads.spawn({
      projectId: source.projectId,
      environment: source.environmentId
        ? { type: "reuse", environmentId: source.environmentId }
        : { type: "project-default" },
      providerId: source.providerId,
      title: `${source.title ?? "Hermes thread"} [compacted]`,
      input: [{ type: "text", text: seed, mentions: [] }],
      visibility: source.visibility,
    });
    if (archiveSource) await bb.sdk.threads.archive({ threadId });
    return { sourceThreadId: threadId, successorThreadId: successor.id, seedChars: seed.length };
  }

  async function checkThread(
    threadId: string,
    trigger: string,
    providerId?: string | null,
  ): Promise<string> {
    if (!cached.enabled) return "skipped: auto-compact is disabled";
    if (inFlight.has(threadId)) {
      return "skipped: compaction already in progress";
    }
    const resolvedProviderId =
      providerId === undefined
        ? await resolveProviderId(threadId)
        : providerId;
    if (isHermesProvider(resolvedProviderId)) {
      return "skipped: Hermes ACP compression does not shrink the BB transcript";
    }
    const threshold = Number(cached.thresholdPercent);
    const unsupportedAt = await bb.storage.kv.get<number>(
      `${UNSUPPORTED_KV_PREFIX}${threadId}`,
    );
    if (
      typeof unsupportedAt === "number" &&
      Date.now() - unsupportedAt < COOLDOWN_MS
    ) {
      return "skipped: provider does not support compaction";
    }
    const lastCompact = await bb.storage.kv.get<number>(
      `${LAST_COMPACT_KV_PREFIX}${threadId}`,
    );
    if (
      typeof lastCompact === "number" &&
      Date.now() - lastCompact < COOLDOWN_MS
    ) {
      return "skipped: compacted recently (cooldown)";
    }
    const { percent } = await readUsage(threadId);
    if (percent === null) return "skipped: usage unavailable";
    if (percent < threshold) {
      return `ok: ${percent.toFixed(1)}% < ${threshold}%`;
    }
    inFlight.add(threadId);
    try {
      await compactThread(threadId);
    } catch (error) {
      if (isUnsupportedCompaction(error)) {
        await bb.storage.kv.set(
          `${UNSUPPORTED_KV_PREFIX}${threadId}`,
          Date.now(),
        );
        bb.log.info(
          `Auto-compact: skipping thread ${threadId}: provider does not support compaction.`,
        );
        return "skipped: provider does not support compaction";
      }
      bb.log.warn(
        `Auto-compact: compaction failed for thread ${threadId}: ${errorMessage(error)}`,
      );
      return "error: compaction failed";
    } finally {
      inFlight.delete(threadId);
    }
    await bb.storage.kv.set(
      `${LAST_COMPACT_KV_PREFIX}${threadId}`,
      Date.now(),
    );
    bb.log.info(
      `Auto-compacted thread ${threadId} at ${percent.toFixed(1)}% of context window (${trigger}, threshold ${threshold}%).`,
    );
    return `compacted at ${percent.toFixed(1)}%`;
  }

  function onSettled(
    threadId: string,
    trigger: string,
    providerId: string | null | undefined,
  ): void {
    void checkThread(threadId, trigger, providerId).catch((error: unknown) => {
      bb.log.warn(
        `Auto-compact: check failed for thread ${threadId}: ${errorMessage(error)}`,
      );
    });
  }
  bb.events.on("thread.idle", ({ thread }) =>
    onSettled(thread.id, "idle", thread.providerId),
  );
  bb.events.on("thread.failed", ({ thread }) =>
    onSettled(thread.id, "failed", thread.providerId),
  );

  // Manual compaction: explicit user intent, so it bypasses the threshold
  // and cooldown. Still guards against overlapping compactions, and records
  // the run so the next automatic check sees a fresh cooldown.
  async function forceCompact(threadId: string): Promise<string> {
    if (inFlight.has(threadId)) {
      return "skipped: compaction already in progress";
    }
    inFlight.add(threadId);
    try {
      const providerId = await resolveProviderId(threadId);
      if (isHermesProvider(providerId)) {
        const successor = await materializeHermesSuccessor(threadId, false);
        return `compacted into successor ${successor.successorThreadId} (${successor.seedChars} chars); source preserved`;
      }
      await compactThread(threadId);
    } catch (error) {
      if (isUnsupportedCompaction(error)) {
        await bb.storage.kv.set(
          `${UNSUPPORTED_KV_PREFIX}${threadId}`,
          Date.now(),
        );
        bb.log.info(
          `Auto-compact: manual compaction not supported for thread ${threadId}.`,
        );
        return `unsupported: ${errorMessage(error)}`;
      }
      bb.log.warn(
        `Auto-compact: manual compaction failed for thread ${threadId}: ${errorMessage(error)}`,
      );
      return `error: ${errorMessage(error)}`;
    } finally {
      inFlight.delete(threadId);
    }
    await bb.storage.kv.set(
      `${LAST_COMPACT_KV_PREFIX}${threadId}`,
      Date.now(),
    );
    bb.log.info(`Manually compacted thread ${threadId}.`);
    return "compacted";
  }

  bb.rpc.register(rpcContract, {
    compact_now: async ({ threadId }) => ({
      result: await forceCompact(threadId),
    }),
    usage: async ({ threadId }) => ({
      ...(await readUsage(threadId)),
      thresholdPercent: Number(cached.thresholdPercent),
    }),
    compact_hermes: async ({ threadId, archiveSource }) =>
      materializeHermesSuccessor(threadId, archiveSource ?? false),
  });

  const usageText = [
    "Usage:",
    "  bb auto-compact status [--json]",
    "  bb auto-compact check [thread-id] [--json]",
    "  bb auto-compact now [thread-id] [--json]",
    "  bb auto-compact compact-hermes <thread-id> [--archive] [--json]",
  ].join("\n");
  bb.cli.register({
    name: "auto-compact",
    summary: "Auto-compact thread context when usage nears the limit",
    commands: [
      {
        name: "status",
        summary: "Show auto-compact settings",
        usage: "bb auto-compact status [--json]",
      },
      {
        name: "check",
        summary: "Check a thread now and compact it if over threshold",
        usage: "bb auto-compact check [thread-id] [--json]",
      },
      {
        name: "now",
        summary: "Compact a thread immediately, bypassing threshold and cooldown",
        usage: "bb auto-compact now [thread-id] [--json]",
      },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const [command, ...rest] = argv.filter((arg) => arg !== "--json");
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usageText };
        case "status": {
          const value = {
            enabled: cached.enabled,
            thresholdPercent: Number(cached.thresholdPercent),
            cooldownMinutes: COOLDOWN_MS / 60_000,
          };
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify(value)
              : `enabled: ${value.enabled}\nthreshold: ${value.thresholdPercent}%\ncooldown: ${value.cooldownMinutes} min`,
          };
        }
        case "check": {
          const threadId = rest[0] ?? ctx.threadId ?? undefined;
          if (threadId === undefined || rest.length > 1) {
            return { exitCode: 1, stderr: usageText };
          }
          const result = await checkThread(threadId, "manual");
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify({ threadId, result })
              : `${threadId}: ${result}`,
          };
        }
        case "now": {
          const threadId = rest[0] ?? ctx.threadId ?? undefined;
          if (threadId === undefined || rest.length > 1) {
            return { exitCode: 1, stderr: usageText };
          }
          const result = await forceCompact(threadId);
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify({ threadId, result })
              : `${threadId}: ${result}`,
          };
        }
        case "compact-hermes": {
          const threadId = rest[0] ?? ctx.threadId ?? undefined;
          const archiveSource = rest.includes("--archive");
          if (threadId === undefined || rest.filter((arg) => arg !== "--archive").length > 1) {
            return { exitCode: 1, stderr: usageText };
          }
          try {
            const result = await materializeHermesSuccessor(threadId, archiveSource);
            return {
              exitCode: 0,
              stdout: json ? JSON.stringify(result) :
                `${result.sourceThreadId} -> ${result.successorThreadId} (${result.seedChars} chars)`,
            };
          } catch (error) {
            return { exitCode: 1, stderr: errorMessage(error) };
          }
        }
        default:
          return { exitCode: 1, stderr: usageText };
      }
    },
  });

  bb.onDispose(() => {
    inFlight.clear();
  });
}
