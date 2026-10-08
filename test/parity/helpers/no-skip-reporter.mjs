// AP8 / AP14 runtime enforcement: a node:test custom reporter.
//
//   node --test --test-reporter=./test/parity/helpers/no-skip-reporter.mjs \
//        --test-reporter-destination=stdout test/parity/*.test.mjs
//
// node:test reports a skipped or todo test as a test:pass / test:fail event
// whose data carries `skip` / `todo` (older and newer Node versions alike);
// this reporter also accepts test:skip / test:todo event types should a future
// Node emit them. It counts pass/fail/skip/todo, names every skipped or todo
// test, and on any non-win32 platform sets a non-zero exit code when at least
// one test was skipped or todo. On win32 the parity suite is skipped by design
// (SKIP), so skips are reported but not fatal. Failures keep their own
// non-zero exit from the runner. This is the AUTHORITATIVE no-skip check; the
// source scan in rows.mjs and the row() throw are best-effort early warnings.
export default async function* noSkipReporter(source) {
  const counts = { pass: 0, fail: 0, skip: 0, todo: 0 };
  const offenders = [];
  for await (const event of source) {
    const { type, data } = event;
    if (!["test:pass", "test:fail", "test:skip", "test:todo"].includes(type)) continue;
    const where = data?.file ? ` (${data.file})` : "";
    if (type === "test:skip" || (data && data.skip !== undefined && data.skip !== false)) {
      counts.skip++;
      offenders.push(`SKIPPED ${data?.name}${where}: ${data?.skip === true ? "" : data?.skip ?? ""}`.trimEnd());
    } else if (type === "test:todo" || (data && data.todo !== undefined && data.todo !== false)) {
      counts.todo++;
      offenders.push(`TODO ${data?.name}${where}: ${data?.todo === true ? "" : data?.todo ?? ""}`.trimEnd());
    } else if (type === "test:pass") {
      counts.pass++;
    } else {
      counts.fail++;
      yield `FAIL ${data?.name}${where}\n`;
    }
  }
  for (const o of offenders) yield `${o}\n`;
  yield `no-skip-reporter: pass ${counts.pass} fail ${counts.fail} skip ${counts.skip} todo ${counts.todo}\n`;
  if (counts.skip + counts.todo > 0 && process.platform !== "win32") {
    yield `no-skip-reporter: ${counts.skip + counts.todo} skipped/todo parity test(s); AP8 forbids skips on this platform\n`;
    process.exitCode = 1;
  }
}
