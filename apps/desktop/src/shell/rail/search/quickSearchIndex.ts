export interface SearchDocument<T = unknown> {
  id: string;
  label: string;
  metadata: string;
  kind: string;
  workspaceId?: string | null;
  keywords?: string;
  target: T;
}

const normalize = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
const grams = (text: string) => {
  const size = Math.min(3, text.length);
  return [...new Set(Array.from({ length: text.length - size + 1 }, (_, i) => text.slice(i, i + size)))];
};

/** Local substring index. Querying never walks project files or mounts the complete result set. */
export class QuickSearchIndex<T> {
  private records = new Map<string, { document: SearchDocument<T>; label: string; text: string }>();
  private postings = new Map<string, Set<string>>();

  add(document: SearchDocument<T>): void {
    const label = normalize(document.label);
    const text = normalize(`${document.label} ${document.metadata} ${document.kind} ${document.keywords ?? ""}`);
    this.records.set(document.id, { document, label, text });
    for (let size = 1; size <= 3; size++) {
      for (let offset = 0; offset <= text.length - size; offset++) {
        const gram = text.slice(offset, offset + size);
        let posting = this.postings.get(gram);
        if (!posting) {
          posting = new Set();
          this.postings.set(gram, posting);
        }
        posting.add(document.id);
      }
    }
  }

  search(
    query: string,
    workspaceId: string | null,
    recent: ReadonlyMap<string, number>,
    limit = 24,
  ): SearchDocument<T>[] {
    const typed = normalize(query.trim());
    const words = typed.split(/\s+/).filter(Boolean);
    let candidates: Iterable<string> = this.records.keys();
    let smallest: Set<string> | undefined;
    for (const word of words) {
      for (const gram of grams(word)) {
        const posting = this.postings.get(gram);
        if (!posting) return [];
        if (!smallest || posting.size < smallest.size) smallest = posting;
      }
    }
    if (smallest) candidates = smallest;
    const best: { document: SearchDocument<T>; score: number }[] = [];
    const now = Date.now();
    for (const id of candidates) {
      const record = this.records.get(id);
      if (!record || !words.every((word) => record.text.includes(word))) continue;
      const used = recent.get(id);
      const score =
        (typed && record.label === typed
          ? 1000
          : typed && record.label.startsWith(typed)
            ? 600
            : typed && record.label.includes(typed)
              ? 400
              : 100) +
        (workspaceId && record.document.workspaceId === workspaceId ? 80 : 0) +
        (used ? Math.max(10, 70 - Math.log2(1 + Math.max(0, now - used) / 60000) * 4) : 0);
      const at = best.findIndex((entry) => entry.score < score);
      if (at >= 0) best.splice(at, 0, { document: record.document, score });
      else if (best.length < limit) best.push({ document: record.document, score });
      if (best.length > limit) best.pop();
    }
    return best.map((entry) => entry.document);
  }
}
