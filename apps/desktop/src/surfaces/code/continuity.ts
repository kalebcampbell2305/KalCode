import type { ThreadSummary } from "@kalcode/protocol";

/** Only persisted open panes interrupted by app exit are automatic recovery candidates. */
export function recoveryCandidates(
  agents: readonly ThreadSummary[],
  openIds: ReadonlySet<string>,
  liveIds: ReadonlySet<string>,
): ThreadSummary[] {
  return agents.filter(
    (agent) =>
      agent.runtimeKind === "interactive_pty" &&
      agent.status === "interrupted" &&
      agent.restartRecoverable === true &&
      agent.resumable &&
      agent.archivedAt === null &&
      openIds.has(agent.id) &&
      !liveIds.has(agent.id),
  );
}

/** App-lifetime restoration admission; native runtime remains the process authority. */
export class RestoreQueue {
  private readonly attempted = new Set<string>();
  private readonly pending = new Map<string, Promise<boolean>>();
  private readonly jobs: (() => Promise<void>)[] = [];
  private active = 0;
  constructor(private readonly concurrency = 2) {}

  retry(ids: readonly string[]) {
    for (const id of ids) if (!this.pending.has(id)) this.attempted.delete(id);
  }

  async restore(
    ids: readonly string[],
    eligible: (id: string) => boolean,
    run: (id: string) => Promise<void>,
  ): Promise<string[]> {
    const results = await Promise.all(
      [...new Set(ids)].map(async (id) => {
        let task = this.pending.get(id);
        if (!task && !this.attempted.has(id)) {
          this.attempted.add(id);
          let finish!: (failed: boolean) => void;
          task = new Promise<boolean>((resolve) => {
            finish = resolve;
          });
          this.pending.set(id, task);
          this.jobs.push(async () => {
            let failed = false;
            try {
              if (eligible(id)) await run(id);
            } catch {
              failed = true;
            } finally {
              this.pending.delete(id);
              finish(failed);
            }
          });
        }
        this.drain();
        return task && (await task) ? id : null;
      }),
    );
    return results.filter((id): id is string => id !== null);
  }

  private drain() {
    while (this.active < this.concurrency && this.jobs.length) {
      const job = this.jobs.shift();
      if (!job) break;
      this.active++;
      void job().finally(() => {
        this.active--;
        this.drain();
      });
    }
  }
}

const queues = new WeakMap<object, RestoreQueue>();
export function restoreQueue(owner: object): RestoreQueue {
  let queue = queues.get(owner);
  if (!queue) {
    queue = new RestoreQueue();
    queues.set(owner, queue);
  }
  return queue;
}
