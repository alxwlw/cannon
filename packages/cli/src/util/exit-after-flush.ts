/**
 * Exits the process once everything already written to stdout and stderr has been handed to the OS.
 *
 * `process.exit()` does not wait for pending writes: when stdout is a pipe, Node writes to it
 * asynchronously, so output still queued in user space (e.g. the JSON `inspect --out deploy-json`
 * emits in small chunks) is lost. An empty write is queued behind every earlier one, so its callback
 * fires only after they have been flushed. The exit itself stays forced: open handles (nodes, sockets,
 * timers) must not keep the CLI alive.
 */
export function exitAfterFlush(code?: Parameters<typeof process.exit>[0]): void {
  const streams = [process.stdout, process.stderr];
  let pending = streams.length;
  const done = () => {
    if (--pending === 0) process.exit(code);
  };
  for (const stream of streams) {
    if (stream.writable) {
      stream.write('', done);
    } else {
      done();
    }
  }
}
