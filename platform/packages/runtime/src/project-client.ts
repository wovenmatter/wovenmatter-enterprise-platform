import { connect } from "node:net";
const socket = connect("/control/runtime.sock");
socket.on("error", () => {
  process.exitCode = 1;
  process.stdin.destroy();
});
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("end", () => process.stdin.destroy());
