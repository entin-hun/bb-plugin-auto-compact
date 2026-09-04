import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";

/** Refresh the usage readout this often while the header is visible. */
const POLL_MS = 30_000;

function CompressIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <polyline points="9.5 4.5 12 7 14.5 4.5" />
      <line x1="4" y1="17" x2="20" y2="17" />
      <line x1="12" y1="22" x2="12" y2="19" />
      <polyline points="9.5 19.5 12 17 14.5 19.5" />
    </svg>
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      className={`animate-spin ${className ?? ""}`}
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeOpacity={0.25}
        strokeWidth={3}
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
      />
    </svg>
  );
}

function CompactButton({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [running, setRunning] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [threshold, setThreshold] = useState(80);

  useEffect(() => {
    let cancelled = false;
    async function refresh(): Promise<void> {
      try {
        const usage = await rpc.call("usage", { threadId });
        if (!cancelled) {
          setPercent(usage.percent);
          setThreshold(usage.thresholdPercent);
        }
      } catch {
        // Ephemeral read; the next poll retries.
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [rpc, threadId]);

  async function onClick(): Promise<void> {
    if (running) return;
    setRunning(true);
    try {
      const { result } = await rpc.call("compact_now", { threadId });
      if (result === "compacted") {
        toast.success("Thread compacted.");
      } else if (result.startsWith("unsupported:")) {
        toast.warning("This thread's provider doesn't support compaction.");
      } else {
        toast.error(`Compaction did not run: ${result}`);
      }
    } catch (error) {
      toast.error(
        `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setRunning(false);
    }
    try {
      const usage = await rpc.call("usage", { threadId });
      setPercent(usage.percent);
      setThreshold(usage.thresholdPercent);
    } catch {
      // Readout refreshes on the next poll.
    }
  }

  const hot = percent !== null && percent >= threshold;
  const title =
    percent === null
      ? "Compact this thread now"
      : `Context usage ${percent.toFixed(0)}%${hot ? ` (at the ${threshold}% auto-compact threshold)` : ""} — compact this thread now`;

  return (
    <button
      type="button"
      title={title}
      aria-label="Compact this thread now"
      disabled={running}
      onClick={() => void onClick()}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
    >
      {running ? <Spinner /> : <CompressIcon />}
      {running ? "Compacting" : "Compact"}
      {percent !== null && !running && (
        <span
          className={`tabular-nums ${hot ? "text-destructive" : "text-muted-foreground"}`}
        >
          {percent.toFixed(0)}%
        </span>
      )}
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "compact-now",
    title: "Compact now",
    component: CompactButton,
  });
});
