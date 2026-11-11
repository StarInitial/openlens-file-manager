#!/usr/bin/env node
/**
 * Fake `kubectl` used ONLY by the local test-suite.
 *
 * It understands just enough of `kubectl [--kubeconfig X] [--context Y] exec
 * -n NS POD [-c C] -- <cmd...>` and runs `<cmd...>` inside WSL instead of a
 * cluster, so the file-manager logic can be exercised end-to-end against a real
 * Linux userspace without touching any Kubernetes cluster.
 */
const { spawn } = require("node:child_process");

const distro = process.env.PODFS_WSL_DISTRO;
const argv = process.argv.slice(2);

const execIndex = argv.indexOf("exec");
if (execIndex < 0) {
  process.stderr.write("fake-kubectl: only the `exec` subcommand is emulated\n");
  process.exit(2);
}

const command = [];
for (let i = execIndex + 1; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--") {
    command.push(...argv.slice(i + 1));
    break;
  }
  if (arg === "-n" || arg === "--namespace" || arg === "-c" || arg === "--container") {
    i += 1; // value
    continue;
  }
  // positional pod name — ignored
}

if (command.length === 0) {
  process.stderr.write("fake-kubectl: no command given\n");
  process.exit(2);
}

const wslArgs = distro ? ["-d", distro, "-e", ...command] : ["-e", ...command];
const child = spawn("wsl.exe", wslArgs, { stdio: ["pipe", "pipe", "pipe"] });

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.stdin.pipe(child.stdin);
process.stdin.on("error", () => undefined);

child.on("close", (code) => process.exit(code === null ? 1 : code));
child.on("error", (error) => {
  process.stderr.write(`fake-kubectl: ${error.message}\n`);
  process.exit(127);
});
