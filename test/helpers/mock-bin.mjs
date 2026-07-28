import fs from "node:fs";
import path from "node:path";

/**
 * Creates a cross-platform mock executable in `dir`.
 * On POSIX: creates `dir/name` with a Node.js shebang and `chmod 0o755`.
 * On Windows: creates `dir/name.js` and `dir/name.cmd` wrapper.
 *
 * @param {string} dir Directory to place mock binary in
 * @param {string} name Base command name (e.g. "claude", "agy", "codex", "git", "agent")
 * @param {string} jsContent JavaScript source code for the mock
 * @returns {string} Primary executable path created
 */
export function writeMockBin(dir, name, jsContent) {
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    try { fs.writeFileSync(pkgPath, '{"type":"module"}'); } catch {}
  }
  if (process.platform === "win32") {
    const jsPath = path.join(dir, `${name}.js`);
    const cmdPath = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(jsPath, jsContent, "utf8");
    fs.writeFileSync(cmdPath, `@echo off\r\nnode "%~dp0${name}.js" %*\r\n`, "utf8");
    return cmdPath;
  } else {
    const binPath = path.join(dir, name);
    const content = jsContent.startsWith("#!") ? jsContent : `#!/usr/bin/env node\n${jsContent}`;
    fs.writeFileSync(binPath, content, "utf8");
    fs.chmodSync(binPath, 0o755);
    return binPath;
  }
}

/**
 * Creates a simple mock binary that outputs static text or exits with code.
 */
export function writeSimpleMockBin(dir, name, stdoutText = "mock", exitCode = 0) {
  const code = `
if (${JSON.stringify(stdoutText)}) process.stdout.write(${JSON.stringify(stdoutText)});
process.exit(${exitCode});
`;
  return writeMockBin(dir, name, code);
}
