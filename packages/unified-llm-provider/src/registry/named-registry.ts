export class NamedRegistry<TValue> {
  private readonly values = new Map<string, TValue>();

  register(name: string, value: TValue): void {
    this.values.set(name, value);
  }

  unregister(name: string): boolean {
    return this.values.delete(name);
  }

  get(name: string): TValue | undefined {
    return this.values.get(name);
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  list(): string[] {
    return [...this.values.keys()];
  }
}
