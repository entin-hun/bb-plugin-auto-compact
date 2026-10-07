// bb-plugin-auto-compact — compact a thread's context window automatically
// when usage reaches a configurable percentage.
//
// How it works: BB reports per-thread context usage on the thread timeline
// (`contextWindowUsage`: used tokens vs. model window). When a thread goes
// idle or fails — exactly the states where BB allows compaction — this plugin
// reads that usage and compacts once it meets the threshold. Hermes ACP is
// provider-owned, so its `/compress` response is used to verify the result;
// other providers use BB's native compaction API.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Minimum time between two auto-compactions of the same thread. */
const COOLDOWN_MS = 15 * 60_000;
const LAST_COMPACT_KV_PREFIX = "last-compact:";
const UNSUPPORTED_KV_PREFIX = "unsupported-compact:";
const HERMES_PROVIDER_ID = "acp-hermes-agent";
const HERMES_COMPRESSION_TIMEOUT_MS = 30_000;
const HERMES_RESULT_RE =
  /Context compressed:\s*([\d,]+)\s*->\s*([\d,]+) messages[\s\S]*?~([\d,]+)\s*->\s*~([\d,]+) tokens/i;

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
    providerId: string | null | undefined,
    waitForVerification = true,
  ): Promise<void> {
    if (isHermesProvider(providerId)) {
      // Hermes exposes compression as the `/compress` command inside its ACP
      // session. Keep this agent-only so the command is not shown as a user
      // message in the BB transcript.
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [
          {
            type: "text",
            text: "/compress",
            mentions: [],
            visibility: "agent-only",
          },
        ],
      });

      const verify = async (): Promise<void> => {
        // `threads.send` only acknowledges dispatch. Wait for Hermes to finish
        // the command, then verify Hermes' explicit compression result. BB's
        // timeline may retain the original transcript size for ACP sessions.
        await bb.sdk.threads.wait({
          threadId,
          status: "idle",
          timeoutMs: HERMES_COMPRESSION_TIMEOUT_MS,
        });
        const { output } = await bb.sdk.threads.output({ threadId });
        const match = output?.match(HERMES_RESULT_RE);
        if (!match) {
          throw new Error(
            "Hermes ACP did not return a verifiable compression result",
          );
        }
        const [, oldMessages, newMessages, oldTokens, newTokens] = match;
        const oldMessageCount = Number(oldMessages.replaceAll(",", ""));
        const newMessageCount = Number(newMessages.replaceAll(",", ""));
        const oldTokenCount = Number(oldTokens.replaceAll(",", ""));
        const newTokenCount = Number(newTokens.replaceAll(",", ""));
        if (
          newMessageCount >= oldMessageCount ||
          newTokenCount >= oldTokenCount
        ) {
          throw new Error(
            `Hermes ACP /compress was a no-op (${oldMessages} -> ${newMessages} messages; ~${oldTokens} -> ~${newTokens} tokens)`,
          );
        }
        bb.log.info(
          `Auto-compact: Hermes compressed thread ${threadId}: ${oldMessages} -> ${newMessages} messages; ~${oldTokens} -> ~${newTokens} tokens.`,
        );
      };
      if (waitForVerification) {
        await verify();
      } else {
        void verify().catch((error: unknown) => {
          bb.log.warn(
            `Auto-compact: Hermes compression verification failed for thread ${threadId}: ${errorMessage(error)}`,
          );
        });
      }
      return;
    }
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

  async function checkThread(
    threadId: string,
    trigger: string,
    providerId?: string | null,
  ): Promise<string> {
    if (!cached.enabled) return "skipped: auto-compact is disabled";
    if (inFlight.has(threadId)) {
      return "skipped: compaction already in progress";
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
      const resolvedProviderId =
        providerId === undefined
          ? await resolveProviderId(threadId)
          : providerId;
      await compactThread(threadId, resolvedProviderId);
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
      const isHermes = isHermesProvider(providerId);
      await compactThread(threadId, providerId, !isHermes);
      if (isHermes) {
        await bb.storage.kv.set(
          `${LAST_COMPACT_KV_PREFIX}${threadId}`,
          Date.now(),
        );
        return "started: Hermes /compress queued; verification pending";
      }
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
  });

  const usageText = [
    "Usage:",
    "  bb auto-compact status [--json]",
    "  bb auto-compact check [thread-id] [--json]",
    "  bb auto-compact now [thread-id] [--json]",
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
        default:
          return { exitCode: 1, stderr: usageText };
      }
    },
  });

  bb.onDispose(() => {
    inFlight.clear();
  });
}
