import { execFile, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { RuntimeError } from "./types.js";

const execute = promisify(execFile);
const identities = new WeakMap<ChildProcess, Promise<string | undefined>>();

/** Capture the direct child's kernel start identity before it can be retired. */
export function trackSandboxProcess(child: ChildProcess) {
  const captured = (async () => {
    if (!child.pid) return undefined;
    try {
      const stat = await readFile(`/proc/${child.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[1]) !== process.pid)
        throw new Error("Sandbox process ownership changed");
      return fields[19]; // starttime, field 22; comm can contain spaces/parentheses.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  })();
  void captured.catch(() => {});
  identities.set(child, captured);
}

/** Trusted control-plane helper; same UID as its own child, existing supervisor profile.
 * A pidfd pins the checked process, so PID reuse cannot redirect the signal.
 * No CAP_KILL, cross-namespace agent signal permission, shell or arbitrary target API.
 */
export async function terminateSandboxProcess(child: ChildProcess) {
  const captured = identities.get(child);
  if (!captured)
    throw new RuntimeError(
      "process_unowned",
      "Sandbox ownership was not recorded.",
    );
  const start = await captured;
  if (
    !start ||
    !child.pid ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  try {
    await execute(
      "/usr/bin/python3",
      [
        "-c",
        `import os,signal,sys
pid,parent,start=map(int,sys.argv[1:])
try:
 fd=os.pidfd_open(pid)
except ProcessLookupError:
 sys.exit(0)
try:
 with open('/proc/'+str(pid)+'/stat') as source: stat=source.read()
 fields=stat[stat.rfind(')')+2:].split()
 if int(fields[1])!=parent or int(fields[19])!=start: raise RuntimeError('Process ownership changed')
 signal.pidfd_send_signal(fd,signal.SIGKILL)
except (ProcessLookupError,FileNotFoundError):
 pass
finally:
 os.close(fd)
`,
        String(child.pid),
        String(process.pid),
        start,
      ],
      {
        uid: 10001,
        gid: 10001,
        env: { PATH: "/usr/bin:/bin" },
        timeout: 5000,
        maxBuffer: 4096,
      },
    );
  } catch (cause) {
    throw Object.assign(
      new RuntimeError(
        "stop_not_confirmed",
        "The owned sandbox process could not be stopped.",
      ),
      { cause },
    );
  }
}
