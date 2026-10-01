import { RuntimeError, type SteeringInput } from "./types.js";
export const steeringText = (input: SteeringInput) =>
  `User ${JSON.stringify(input.authorName)} (${input.authorId}), message ${input.sequence}:\n${input.content}`;
/** Admission is serialized separately from execution and drained before completion. */
export class SteeringChannel {
  private handler?: (input: SteeringInput) => Promise<void>;
  private readyResolve!: () => void;
  private ready = new Promise<void>((resolve) => {
    this.readyResolve = resolve;
  });
  private closed = false;
  private lane = Promise.resolve();
  set(handler: (input: SteeringInput) => Promise<void>) {
    if (!this.closed) {
      this.handler = handler;
      this.readyResolve();
    }
  }
  submit(input: SteeringInput) {
    const result = this.lane.then(async () => {
      await this.ready;
      if (this.closed || !this.handler)
        throw new RuntimeError("run_ended", "The active run has ended.");
      await this.handler(input);
    });
    this.lane = result.catch(() => {});
    return result;
  }
  async settle() {
    this.closed = true;
    this.readyResolve();
    await this.lane;
  }
}
