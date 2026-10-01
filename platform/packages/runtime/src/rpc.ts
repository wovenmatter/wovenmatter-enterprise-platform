import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { RuntimeError } from "./types.ts";
import { MAX_LINE, MAX_OUTPUT } from "./validation.ts";

export type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: unknown;
};
/** Bounded newline-JSON RPC. No shell interpolation and no inherited host environment. */
export class JsonRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private ended = false;
  private eventQueue = Promise.resolve();
  readonly closed: Promise<void>;
  private rejectClosed!: (error: Error) => void;
  onMessage: (message: RpcMessage) => Promise<void> = async () => {};
  constructor(
    command: string,
    args: string[],
    environment: Record<string, string>,
    cwd = "/workspace",
  ) {
    this.child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.closed = new Promise<void>((_resolve, reject) => {
      this.rejectClosed = reject;
    });
    void this.closed.catch(() => {});
    this.child.once("error", () =>
      this.fail(
        new RuntimeError(
          "harness_unavailable",
          "The selected agent executable is unavailable",
        ),
      ),
    );
    this.child.once("close", () =>
      this.fail(
        new RuntimeError(
          "harness_disconnected",
          "The agent disconnected before completion",
        ),
      ),
    );
    this.child.stdin.on("error", () =>
      this.fail(
        new RuntimeError(
          "harness_disconnected",
          "The agent input disconnected",
        ),
      ),
    );
    this.child.stderr.resume(); // Native logs may contain credentials or document text: do not forward.
    let buffer = Buffer.alloc(0),
      queuedBytes = 0,
      queuedEvents = 0;
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let end: number;
      while ((end = buffer.indexOf(10)) >= 0) {
        if (end > MAX_LINE) {
          this.fail(
            new RuntimeError(
              "protocol_limit",
              "Agent protocol event exceeds limit",
            ),
          );
          return;
        }
        const line = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 1);
        if (!line) continue;
        let message: RpcMessage;
        try {
          message = JSON.parse(line);
        } catch {
          this.fail(
            new RuntimeError(
              "protocol_invalid",
              "Agent emitted invalid protocol data",
            ),
          );
          return;
        }
        if (!message || typeof message !== "object") {
          this.fail(
            new RuntimeError(
              "protocol_invalid",
              "Agent emitted invalid protocol data",
            ),
          );
          return;
        }
        if (
          typeof message.id === "number" &&
          !message.method &&
          this.pending.has(message.id)
        ) {
          const request = this.pending.get(message.id)!;
          this.pending.delete(message.id);
          clearTimeout(request.timer);
          if (message.error)
            request.reject(
              new RuntimeError(
                "protocol_rejected",
                "The agent rejected the runtime protocol request",
              ),
            );
          else request.resolve(message.result);
        } else {
          const bytes = Buffer.byteLength(line);
          queuedBytes += bytes;
          if (++queuedEvents > 4096 || queuedBytes > MAX_OUTPUT * 4) {
            this.fail(
              new RuntimeError(
                "protocol_limit",
                "Agent protocol event queue exceeds limit",
              ),
            );
            return;
          }
          this.eventQueue = this.eventQueue
            .then(() => this.onMessage(message))
            .finally(() => {
              queuedEvents--;
              queuedBytes -= bytes;
            });
          void this.eventQueue.catch(() =>
            this.fail(
              new RuntimeError(
                "protocol_failed",
                "Agent protocol handling failed",
              ),
            ),
          );
        }
      }
      if (buffer.length > MAX_LINE)
        this.fail(
          new RuntimeError(
            "protocol_limit",
            "Agent protocol event exceeds limit",
          ),
        );
    });
  }
  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.rejectClosed(error);
    this.child.kill("SIGKILL");
  }
  send(message: RpcMessage): void {
    if (this.ended)
      throw new RuntimeError(
        "harness_disconnected",
        "The agent is disconnected",
      );
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method: string, params: unknown, timeoutMs = 30000): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RuntimeError(
            "protocol_timeout",
            "Agent protocol timed out; delivery is uncertain",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async flush(): Promise<void> {
    await this.eventQueue;
  }
  close(): void {
    this.fail(new RuntimeError("harness_closed", "Agent closed"));
  }
}
