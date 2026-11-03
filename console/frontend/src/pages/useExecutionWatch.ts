// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  errorMessage,
  getExecutionEvents,
  getExecutionLogs,
  watchExecution,
  type ExecutionDetail,
  type ExecutionEvent,
  type TaskLogs,
} from "../api";

export const TERMINAL_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
/** The wait after a failed attempt to watch, doubling up to the maximum. */
export const RETRY_MIN_MS = 2000;
export const RETRY_MAX_MS = 30_000;
/** A stream that delivered but ended sooner than this is reopened after this long, not at once. */
export const REOPEN_MIN_MS = 1000;

export interface ExecutionWatch {
  execution: ExecutionDetail | null;
  events: ExecutionEvent[];
  logs: TaskLogs[];
  error: string | null;
  /** Watch again, even if it had stopped: after a retry or a cancel, a
   * finished execution can be live again. */
  resume: () => void;
}

const permanent = (error: unknown) =>
  error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * An execution's status, event log and container output, kept current by
 * WatchExecution: the server sends the execution whenever it changes, and
 * the events (from a cursor) and logs (a full snapshot: each task's row is
 * overwritten per attempt) are fetched with each one. It stops once the
 * execution has finished, or on a 4xx, which watching again won't change.
 * A stream that ends unfinished (the server's limit per stream) or drops
 * after delivering is reopened at once (after REOPEN_MIN_MS if it lasted
 * less, so something cutting streams short can't make it spin); one that can't be opened, or ends
 * without sending anything (the server always sends the execution first),
 * is tried again, less and less often, with its error shown until it works.
 */
export function useExecutionWatch(id: string): ExecutionWatch {
  const [execution, setExecution] = useState<ExecutionDetail | null>(null);
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [logs, setLogs] = useState<TaskLogs[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Bumped by resume(): starts the watching effect again.
  const [round, setRound] = useState(0);
  const cursorRef = useRef<number | undefined>(undefined);

  // A different execution starts from nothing.
  useEffect(() => {
    setExecution(null);
    setEvents([]);
    setLogs([]);
    setError(null);
    cursorRef.current = undefined;
  }, [id]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    async function refresh(): Promise<void> {
      const [eventPage, logsPage] = await Promise.all([
        getExecutionEvents(id, cursorRef.current),
        getExecutionLogs(id),
      ]);
      if (signal.aborted) return;
      setLogs(logsPage.tasks);
      if (eventPage.events.length > 0) {
        setEvents((prev) => [...prev, ...eventPage.events]);
        cursorRef.current = eventPage.events[eventPage.events.length - 1]?.id;
      }
    }

    async function watch(): Promise<void> {
      let failures = 0;
      while (!signal.aborted) {
        let delivered = false;
        let finished = false;
        const opened = Date.now();
        try {
          for await (const detail of watchExecution(id, signal)) {
            delivered = true;
            finished = TERMINAL_STATES.has(detail.state);
            setExecution(detail);
            await refresh();
            if (signal.aborted) return;
            setError(null);
          }
          if (finished) return;
          if (delivered) {
            failures = 0;
            const lasted = Date.now() - opened;
            if (lasted < REOPEN_MIN_MS) await sleep(REOPEN_MIN_MS - lasted, signal);
          } else {
            // Ended at once, empty: reopening at once would only spin.
            failures += 1;
            await sleep(Math.min(RETRY_MIN_MS * 2 ** (failures - 1), RETRY_MAX_MS), signal);
          }
        } catch (err) {
          if (signal.aborted) return;
          if (permanent(err)) {
            setError((err as ApiError).message);
            return;
          }
          if (delivered) {
            failures = 0;
            const lasted = Date.now() - opened;
            if (lasted < REOPEN_MIN_MS) await sleep(REOPEN_MIN_MS - lasted, signal);
          } else {
            failures += 1;
            setError(errorMessage(err, "Couldn't reach the console. Retrying."));
            await sleep(Math.min(RETRY_MIN_MS * 2 ** (failures - 1), RETRY_MAX_MS), signal);
          }
        }
      }
    }

    void watch();
    return () => {
      controller.abort();
    };
  }, [id, round]);

  const resume = useCallback(() => {
    setRound((r) => r + 1);
  }, []);

  return { execution, events, logs, error, resume };
}
