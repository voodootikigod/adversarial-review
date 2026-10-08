// Network recorder preload (T50 item 13, AP6). CommonJS so it loads with
// `node --require <abs path>` on every supported Node (18-24).
//
// A NO-OP unless PARITY_FETCH_LOG=<abs file> is set (so `node --test`
// discovery, which runs this file directly, sees a silent exit 0). When set, it
// wraps globalThis.fetch and the `request` / `get` functions of the module
// objects that require('http') and require('https') return, and appends one
// NDJSON line `{"api":"fetch"|"http.request"|...,"url":"<full url>"}` per
// request BEFORE delegating. A reentrancy guard keeps a get() that calls
// request() from being logged twice. Child processes are out of scope.
//
// TEST-ONLY: PARITY_NET_HOOK_DISABLE=http leaves http/https unpatched (fetch is
// still recorded), so the harness can prove its consistency check is not vacuous.
"use strict";

const LOG = process.env.PARITY_FETCH_LOG;

if (LOG) {
  const fs = require("fs");
  let depth = 0;

  const record = (api, url) => {
    try {
      fs.appendFileSync(LOG, JSON.stringify({ api, url: String(url) }) + "\n");
    } catch {
      // Recording must never change the program's behavior.
    }
  };

  const urlFromArgs = (args, defaultProtocol) => {
    let base = null;
    let opts = null;
    if (typeof args[0] === "string" || args[0] instanceof URL) {
      base = new URL(String(args[0]));
      if (args[1] && typeof args[1] === "object" && typeof args[1] !== "function") opts = args[1];
    } else if (args[0] && typeof args[0] === "object") {
      opts = args[0];
    }
    if (!opts) return base ? base.href : `${defaultProtocol}//localhost/`;
    const protocol = opts.protocol || (base ? base.protocol : defaultProtocol);
    const host = opts.hostname || (opts.host ? String(opts.host).replace(/:\d+$/, "") : null) || (base ? base.hostname : "localhost");
    const port = opts.port || (base ? base.port : "");
    const p = opts.path || (base ? base.pathname + base.search : "/");
    return `${protocol}//${host}${port ? `:${port}` : ""}${p}`;
  };

  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function parityRecordedFetch(input, init) {
      let url;
      if (typeof input === "string") url = input;
      else if (input instanceof URL) url = input.href;
      else url = input && input.url;
      if (depth === 0) record("fetch", url);
      return originalFetch.call(this, input, init);
    };
  }

  if (process.env.PARITY_NET_HOOK_DISABLE !== "http") {
    for (const [name, defaultProtocol] of [["http", "http:"], ["https", "https:"]]) {
      const mod = require(name);
      for (const fn of ["request", "get"]) {
        const original = mod[fn];
        mod[fn] = function parityRecorded(...args) {
          if (depth === 0) record(`${name}.${fn}`, urlFromArgs(args, defaultProtocol));
          depth++;
          try {
            return original.apply(this, args);
          } finally {
            depth--;
          }
        };
      }
    }
    // Make ESM named imports (import { request } from "node:http") see the patch.
    require("module").syncBuiltinESMExports();
  }
}
