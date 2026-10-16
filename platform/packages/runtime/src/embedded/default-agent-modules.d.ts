declare module "./default-agent/src/durable-session.mjs" {
  export function openDurableSession(
    engine: unknown,
    id?: string,
    requested?: string,
  ): Promise<unknown>;
}
