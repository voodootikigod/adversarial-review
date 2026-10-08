// `#!/bin/sh` mock provider CLIs for the parity suite (T50 item 5, AP8).
//
// writeMockCli(mocksDir, name, { responses, recordEnv, repeatLast, recordsDir, fifoDir })
// generates <mocksDir>/<name>. Each queued response is stored as files under
// <mocksDir>/.<name>.d/<n>/ and read by the script with `cat` by ABSOLUTE path;
// mkdir/cat/sleep/touch/rm are also baked in by absolute host path, so the
// script never depends on PATH. Nothing is embedded via heredoc.
//
// Per real invocation n (1-based, per mock):
//   records/<name>/<n>.argv   one argument per line (spec format)
//   records/<name>/<n>.argvz  NUL-separated arguments (exact, used by readers)
//   records/<name>/<n>.stdin  stdin bytes
//   records/<name>/<n>.env    `NAME=<value or empty>` for each recordEnv name
//   records/<name>/<n>.seq    global sequence number across all mocks of a context
// then it applies response n: writeFiles (relative to cwd, nested dirs created),
// touchMarker, waitFifo (blocks on <fifoDir>/<name> until the test releases it),
// sleep (timeout rows only), stdout, stderr, exit.
//
// Output contract (verified against callCliLLM / callCodexCli in src/llm.js):
// when argv contains `--output-last-message <file>` (codex exec) the response
// stdout is WRITTEN TO THAT FILE and nothing is printed; every other CLI prints
// the response on stdout.
//
// Probes: exactly one argument that is `--version`, `-h` or `--help` prints
// `1.0.0`, exits 0, is recorded under records/<name>/probes/, and does NOT
// consume a response (probeFixer, src/loop.js).
//
// Exhausted queue: exit 97 with stderr `parity-mock: unexpected call` (the call
// is still recorded), unless `repeatLast: true`.
//
// RETRY CONTRACT (2.11.1; rows rely on it): a non-timeout failure of the claude
// path (callCliLLM) or the codex path (callCodexCli) is retried ONCE as argv
// delivery, unless the stderr is an unknown-flag rejection
// (describeUnknownFlagRejection, claude path only) or the prompt exceeds
// maxArgvPromptBytes(). A failing claude/codex reviewer is therefore invoked
// TWICE (stdin, then argv) and the surfaced error text comes from the second
// attempt's stderr. Script two failure responses with failTwice({ stderr, exit })
// and assert two invocations.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const toolCache = new Map();

// Absolute path of a host tool, resolved from the PARENT's PATH (never the
// child's curated PATH). Lazy: no import-time side effects.
export function hostTool(name) {
  if (toolCache.has(name)) return toolCache.get(name);
  const dirs = (process.env.PATH || "").split(path.delimiter).concat(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  for (const dir of dirs) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) {
        toolCache.set(name, p);
        return p;
      }
    } catch { /* keep looking */ }
  }
  throw new Error(`parity harness: host tool "${name}" not found`);
}

function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function failTwice({ stderr = "", exit = 1 } = {}) {
  return [{ stderr, exit }, { stderr, exit }];
}

const REVIEW_ROLE = /You are performing an adversarial (?:software review|review of a design artifact)/;
const VERIFY_ROLE = /You are re-examining a single code-review finding\. Your job is to REFUTE it only when you can\./;

export function isVerifyPrompt(text) {
  return VERIFY_ROLE.test(String(text ?? ""));
}

export function isReviewPrompt(text) {
  const s = String(text ?? "");
  return REVIEW_ROLE.test(s) && !isVerifyPrompt(s);
}

function writeResponse(dir, r) {
  fs.mkdirSync(dir, { recursive: true });
  if (r.sleep != null && !(Number(r.sleep) >= 0)) throw new Error(`mock response sleep must be a number, got ${r.sleep}`);
  fs.writeFileSync(path.join(dir, "stdout"), r.stdout ?? "");
  fs.writeFileSync(path.join(dir, "stderr"), r.stderr ?? "");
  fs.writeFileSync(path.join(dir, "exit"), String(r.exit ?? 0));
  if (r.sleep != null) fs.writeFileSync(path.join(dir, "sleep"), String(r.sleep));
  if (r.touchMarker) fs.writeFileSync(path.join(dir, "marker"), r.touchMarker);
  if (r.waitFifo) fs.writeFileSync(path.join(dir, "fifo"), r.waitFifo);
  const writes = Object.entries(r.writeFiles ?? {});
  if (writes.length) {
    const lines = [];
    writes.forEach(([rel, content], i) => {
      if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
        throw new Error(`mock writeFiles path must be relative and inside cwd: ${rel}`);
      }
      if (/[\t\n]/.test(rel)) throw new Error(`mock writeFiles path may not contain tabs/newlines: ${rel}`);
      const src = path.join(dir, `write-${i}`);
      fs.writeFileSync(src, content);
      const parent = path.dirname(rel);
      lines.push(`${parent}\t${src}\t${rel}`);
    });
    fs.writeFileSync(path.join(dir, "writes"), lines.join("\n") + "\n");
  }
}

export function fifoPath(fifoDir, name) {
  return path.join(fifoDir, name);
}

export function writeMockCli(mocksDir, name, { responses = [], recordEnv = [], repeatLast = false, recordsDir, fifoDir } = {}) {
  if (!recordsDir) throw new Error("writeMockCli: recordsDir is required (use ctx.mock())");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`writeMockCli: invalid mock name ${name}`);
  for (const v of recordEnv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) throw new Error(`writeMockCli: invalid env name ${v}`);
  }
  const dataDir = path.join(mocksDir, `.${name}.d`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  responses.forEach((r, i) => {
    writeResponse(path.join(dataDir, String(i + 1)), r);
    if (r.waitFifo) {
      if (!fifoDir) throw new Error("writeMockCli: waitFifo needs fifoDir (use ctx.mock())");
      if (!/^[A-Za-z0-9._-]+$/.test(r.waitFifo)) throw new Error(`invalid fifo name ${r.waitFifo}`);
      fs.mkdirSync(fifoDir, { recursive: true });
      const fp = fifoPath(fifoDir, r.waitFifo);
      if (!fs.existsSync(fp)) {
        const mk = spawnSync(hostTool("mkfifo"), [fp], { encoding: "utf8" });
        if (mk.status !== 0) throw new Error(`mkfifo failed: ${mk.stderr}`);
      }
    }
  });
  const recDir = path.join(recordsDir, name);
  fs.mkdirSync(path.join(recDir, "probes"), { recursive: true });

  const MKDIR = q(hostTool("mkdir"));
  const CAT = q(hostTool("cat"));
  const SLEEP = q(hostTool("sleep"));
  const TOUCH = q(hostTool("touch"));
  const RM = q(hostTool("rm"));
  const envLines = recordEnv.map((v) => `printf '%s=%s\\n' ${q(v)} "\${${v}-}" >> "$R/$n.env"`).join("\n");

  const script = `#!/bin/sh
# parity-mock: ${name} (generated by test/parity/helpers/mock-cli.mjs; do not edit)
R=${q(recDir)}
ROOT=${q(recordsDir)}
D=${q(dataDir)}
FIFODIR=${q(fifoDir ?? "")}
TOTAL=${responses.length}
REPEAT=${repeatLast ? 1 : 0}
lock() { while ! ${MKDIR} "$ROOT/.lock" 2>/dev/null; do :; done; }
unlock() { ${RM} -rf "$ROOT/.lock"; }
next() { c=0; if [ -f "$1" ]; then c=$(${CAT} "$1"); fi; c=$((c + 1)); printf '%s' "$c" > "$1"; }
if [ "$#" -eq 1 ]; then
  case "$1" in
    --version|-h|--help)
      lock; next "$R/probes/.count"; p=$c; unlock
      printf '%s\\n' "$@" > "$R/probes/$p.argv"
      printf '1.0.0\\n'
      exit 0;;
  esac
fi
lock; next "$R/.count"; n=$c; next "$ROOT/.seq"; s=$c; unlock
printf '%s' "$s" > "$R/$n.seq"
: > "$R/$n.argv"; : > "$R/$n.argvz"; : > "$R/$n.env"
for a in "$@"; do printf '%s\\n' "$a" >> "$R/$n.argv"; printf '%s\\0' "$a" >> "$R/$n.argvz"; done
${CAT} > "$R/$n.stdin"
${envLines}
if [ -d "$D/$n" ]; then RD="$D/$n"
elif [ "$REPEAT" = 1 ] && [ "$TOTAL" -gt 0 ]; then RD="$D/$TOTAL"
else printf 'parity-mock: unexpected call\\n' >&2; exit 97
fi
if [ -f "$RD/writes" ]; then
  while IFS='	' read -r dir src dest; do
    ${MKDIR} -p "$dir"
    ${CAT} "$src" > "$dest"
  done < "$RD/writes"
fi
if [ -f "$RD/marker" ]; then ${TOUCH} "$(${CAT} "$RD/marker")"; fi
if [ -f "$RD/fifo" ]; then
  f="$FIFODIR/$(${CAT} "$RD/fifo")"
  if [ ! -f "$RD/marker" ]; then ${TOUCH} "$f.marker"; fi
  ${CAT} "$f" > /dev/null
fi
if [ -f "$RD/sleep" ]; then ${SLEEP} "$(${CAT} "$RD/sleep")"; fi
OLM=; prev=
for a in "$@"; do if [ "$prev" = "--output-last-message" ]; then OLM=$a; fi; prev=$a; done
if [ -n "$OLM" ]; then ${CAT} "$RD/stdout" > "$OLM"; else ${CAT} "$RD/stdout"; fi
${CAT} "$RD/stderr" >&2
exit "$(${CAT} "$RD/exit")"
`;
  const file = path.join(mocksDir, name);
  fs.writeFileSync(file, script, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

function readIf(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

function parseEnv(text) {
  const env = {};
  for (const line of (text ?? "").split("\n")) {
    if (!line) continue;
    const i = line.indexOf("=");
    env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

// Ordered non-probe invocations: [{ n, seq, argv, stdin, env }].
export function readMockRecords(recordsDir, name) {
  const dir = path.join(recordsDir, name);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^\d+\.argvz$/.test(f))
    .map((f) => Number(f.split(".")[0]))
    .sort((a, b) => a - b)
    .map((n) => {
      const z = readIf(path.join(dir, `${n}.argvz`)) ?? "";
      return {
        n,
        seq: Number(readIf(path.join(dir, `${n}.seq`)) ?? 0),
        argv: z === "" ? [] : z.slice(0, -1).split("\0"),
        stdin: readIf(path.join(dir, `${n}.stdin`)) ?? "",
        env: parseEnv(readIf(path.join(dir, `${n}.env`)))
      };
    });
}

export function readMockProbes(recordsDir, name) {
  const dir = path.join(recordsDir, name, "probes");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^\d+\.argv$/.test(f))
    .map((f) => Number(f.split(".")[0]))
    .sort((a, b) => a - b)
    .map((n) => ({ n, argv: (readIf(path.join(dir, `${n}.argv`)) ?? "").split("\n").filter(Boolean) }));
}

// Every mock name that has a records dir under recordsDir.
export function listMocks(recordsDir) {
  if (!fs.existsSync(recordsDir)) return [];
  return fs.readdirSync(recordsDir).filter((f) => !f.startsWith(".") && fs.statSync(path.join(recordsDir, f)).isDirectory()).sort();
}
