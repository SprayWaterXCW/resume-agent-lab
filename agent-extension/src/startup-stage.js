const failure = (code) => Object.assign(new Error(code), { code });

/** Bound asynchronous Chrome startup calls; late completions never resume a stopped task. */
export function startupStage(work, { signal, timeoutMs, timeoutCode }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(failure("USER_STOPPED")); return; }
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, failure("USER_STOPPED"));
    const timer = setTimeout(() => finish(reject, failure(timeoutCode)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(work).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

export function openAgentSocket(socket, options) {
  return startupStage(() => new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(failure("LOCAL_SERVICE_UNAVAILABLE"));
    socket.onclose = () => reject(failure("LOCAL_SERVICE_UNAVAILABLE"));
  }), { ...options, timeoutCode: "LOCAL_SERVICE_CONNECT_TIMEOUT" });
}
