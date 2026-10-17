import { connect } from "node:net";

// Stands in for `codex app-server proxy`: pipes stdio bytes to a socket.
const socket = connect(process.argv[2]);
socket.on("error", (error) => {
  process.stderr.write(`failed to connect: ${error.message}\n`);
  process.exit(1);
});
socket.on("close", () => process.exit(0));
process.stdin.pipe(socket);
socket.pipe(process.stdout);
