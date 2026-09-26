import type { AgentEvent, ThreadMessage, ThreadSummary, ToolCallRecord } from "@kalcode/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { type KalCodeError, toKalCodeError } from "../../ipc/errors.ts";
import { useEvents, useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { isThreadEvent } from "./model.ts";

type LoadState = "loading" | "ready" | "error";

const MESSAGE_PAGE = 200;
const TOOL_PAGE = 200;
/** Coalesces bursts of events (a streaming turn emits many) into one refetch. */
const REFETCH_DELAY_MS = 80;

/**
 * Calls `onChange` (debounced) whenever the event log records a thread-related event that
 * matches `filter`. The event log is the single source of change notifications.
 */
function useThreadEvents(filter: (threadId: string | null) => boolean, onChange: () => void) {
  const { client } = useRuntime();
  const { events } = useEvents();
  const source = useRef(client);
  const lastSeq = useRef<number | null>(null);
  const latest = useRef({ filter, onChange });
  latest.current = { filter, onChange };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (source.current !== client) {
      source.current = client;
      lastSeq.current = null;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    }
    const newest = events[0]?.seq ?? 0;
    if (lastSeq.current === null) {
      lastSeq.current = newest;
      return;
    }
    const since = lastSeq.current;
    lastSeq.current = Math.max(since, newest);
    const relevant = events.some(
      (event) => event.seq > since && isThreadEvent(event.type) && latest.current.filter(event.correlation.threadId),
    );
    if (!relevant || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      latest.current.onChange();
    }, REFETCH_DELAY_MS);
  }, [client, events]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
}

export interface ThreadListEntry {
  thread: ThreadSummary;
  archived: boolean;
}

export function useThreadList(includeArchived: boolean) {
  const { client } = useRuntime();
  const [entries, setEntries] = useState<ThreadListEntry[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<KalCodeError | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    try {
      const open = await client.listThreads({ includeArchived: false });
      // Summaries don't say whether a thread is archived; anything only in the full list is.
      const all = includeArchived ? await client.listThreads({ includeArchived: true }) : open;
      if (id !== request.current) return;
      const openIds = new Set(open.map((t) => t.id));
      setEntries(all.map((thread) => ({ thread, archived: !openIds.has(thread.id) })));
      setState("ready");
      setError(null);
    } catch (err) {
      if (id !== request.current) return;
      setError(toKalCodeError(err));
      setState((current) => (current === "ready" ? "ready" : "error"));
    }
  }, [client, includeArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  useThreadEvents(() => true, load);

  const retry = useCallback(() => {
    setState("loading");
    void load();
  }, [load]);

  return { entries, state, error, reload: load, retry };
}

export interface LiveMessage {
  messageId: string;
  text: string;
  done: boolean;
}

export function useThreadDetail(threadId: string) {
  const { client } = useRuntime();
  const [thread, setThread] = useState<ThreadSummary | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [tools, setTools] = useState<ToolCallRecord[]>([]);
  const [live, setLive] = useState<LiveMessage[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<KalCodeError | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    try {
      const [summary, page, calls] = await Promise.all([
        client.getThread(threadId),
        client.threadMessages(threadId, MESSAGE_PAGE),
        client.threadToolCalls(threadId, TOOL_PAGE),
      ]);
      if (id !== request.current) return;
      setThread(summary);
      setMessages(page);
      setTools(calls);
      // A completed streamed message is replaced by its stored copy once the history has it.
      setLive((current) =>
        current.filter((m) => !(m.done && page.some((p) => p.role === "assistant" && p.content === m.text))),
      );
      setState("ready");
      setError(null);
    } catch (err) {
      if (id !== request.current) return;
      setError(toKalCodeError(err));
      setState((current) => (current === "ready" ? "ready" : "error"));
    }
  }, [client, threadId]);

  useEffect(() => {
    setState("loading");
    setThread(null);
    setMessages([]);
    setTools([]);
    setLive([]);
    void load();
  }, [load]);

  useThreadEvents((id) => id === threadId, load);

  // Live message deltas (not persisted events) arrive over the thread's own stream.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => Promise<void>) | null = null;
    const onEvent = (event: AgentEvent) => {
      // Native subscription registration may resolve after this effect was replaced.
      if (cancelled) return;
      if (event.kind === "message_delta") {
        setLive((current) => {
          const existing = current.find((m) => m.messageId === event.messageId);
          if (!existing) return [...current, { messageId: event.messageId, text: event.text, done: false }];
          return current.map((m) => (m.messageId === event.messageId ? { ...m, text: m.text + event.text } : m));
        });
      } else if (event.kind === "message_completed") {
        setLive((current) =>
          current.map((m) => (m.messageId === event.messageId ? { ...m, text: event.text, done: true } : m)),
        );
      }
    };
    client
      .streamThread(threadId, onEvent)
      .then((stop) => {
        if (cancelled) void stop();
        else unsubscribe = stop;
      })
      .catch(() => {
        // Live text is a convenience: stored messages still arrive through the event log.
      });
    return () => {
      cancelled = true;
      void unsubscribe?.();
    };
  }, [client, threadId]);

  const retry = useCallback(() => {
    setState("loading");
    void load();
  }, [load]);

  return { thread, messages, tools, live, state, error, reload: load, retry, setThread };
}
