/** A conversation cannot publish overlapping model/result writes. Other conversations run independently. */
export class SessionLock {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(id: string): Promise<() => void> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(id, tail);
    await previous;
    return () => {
      release();
      if (this.tails.get(id) === tail) this.tails.delete(id);
    };
  }
}
