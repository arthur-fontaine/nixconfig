import { apply, SandboxState } from 'nono-ts';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function getShell() {
  const shell = process.env.SHELL;
  if (shell && existsSync(shell)) return shell;
  if (existsSync('/bin/bash')) return '/bin/bash';
  return 'sh';
}

let child;
const killChild = () => {
  if (!child) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, 250).unref();
};

process.on('SIGTERM', () => {
  killChild();
  process.exit(143);
});
process.on('SIGINT', () => {
  killChild();
  process.exit(130);
});

const stdinChunks = [];
for await (const chunk of process.stdin) stdinChunks.push(chunk);

try {
  const request = JSON.parse(Buffer.concat(stdinChunks).toString('utf8'));
  const state = SandboxState.fromJson(request.stateJson);
  apply(state.toCaps());

  const shell = getShell();
  const shellArgs = shell.endsWith('bash') ? ['-c', request.command] : ['-c', request.command];
  child = spawn(shell, shellArgs, {
    cwd: request.cwd,
    env: request.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (data) => send({ type: 'data', data: data.toString('base64') }));
  child.stderr?.on('data', (data) => send({ type: 'data', data: data.toString('base64') }));
  child.on('error', (error) => {
    send({ type: 'error', error: error.message });
    process.exit(1);
  });
  child.on('close', (code) => {
    send({ type: 'end', exitCode: code });
    process.exit(typeof code === 'number' ? 0 : 1);
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  send({ type: 'error', error: message });
  process.exit(1);
}
