import { configureLLM, builderContextKey } from "./llm.js";
import { withResolution, resolutionMatches, withoutCacheEntry, mutateConfigFile } from "./config-store.js";
import { log } from "./utils.js";

// Shared provider-resolution lifecycle (T21), used by the normal review path and
// BOTH loop paths so cache success-persistence and stale-provider recovery behave
// identically everywhere.

const label = (c) => `${c.provider}${c.cliCmd ? `:${c.cliCmd}` : ""}`;

// A failure that plausibly means the cached resolution's CREDENTIAL is dead
// (revoked/expired key, logged-out CLI session) rather than a transient network/
// 5xx or a content/parse error — which must NOT invalidate the cache. API auth
// surfaces as a preserved 401/403; a CLI session failure only as text.
export function isProviderAuthFailure(err) {
  if (typeof err?.status === "number") return err.status === 401 || err.status === 403;
  const text = `${err?.message || ""}\n${err?.stderr ? String(err.stderr) : ""}`.toLowerCase();
  return /\b(401|403)\b|unauthorized|forbidden|authentication|not logged in|invalid api key|api key.*(invalid|expired)|please (run )?login|session (has )?expired|log ?in to/.test(text);
}

// Persist the resolution ONLY after a fully successful review — a resolution that
// never produced a review must not be cached. Reread-merges under a lock so a
// concurrent run's other cache keys and a user's model-pin edit survive; never
// overwrites a malformed or newer-version file. No-op unless auto-detected.
export function persistAutoResolution(config) {
  const entry = config?._autoResolution;
  if (!entry) return;
  const key = builderContextKey();
  const next = { ...entry, resolvedAt: new Date().toISOString() };
  mutateConfigFile((cur) =>
    resolutionMatches(cur.cache?.[key], next) ? null : withResolution(cur, key, next)
  );
}

// Run `reviewOnce(config)`; if a CACHE-SOURCED resolution fails a CLASSIFIED auth/
// session check, invalidate that cache entry and re-detect ONCE with the failed
// provider EXCLUDED (so the ladder advances past it), then retry. A fresh-ladder
// failure or any non-auth failure is surfaced as-is. Returns the config actually
// used, so the caller persists the resolution that truly succeeded.
export async function withProviderFallback(args, config, reviewOnce) {
  try {
    return { result: await reviewOnce(config), config };
  } catch (err) {
    if (!config._fromCache || !isProviderAuthFailure(err)) throw err;
    const key = builderContextKey();
    const pruned = withoutCacheEntry(args.config, key);
    mutateConfigFile((cur) => withoutCacheEntry(cur, key));
    args.config = pruned;
    const exclude = {
      providers: [...(args.exclude?.providers || []), config.provider],
      clis: [...(args.exclude?.clis || []), ...(config.cliCmd ? [config.cliCmd] : [])]
    };
    let fresh;
    try {
      fresh = configureLLM({ ...args, config: pruned, exclude });
    } catch {
      log.warn(`Cached provider "${label(config)}" failed authentication; removed the stale cache entry (next run re-detects). No alternative provider is available.`);
      throw err;
    }
    log.warn(`Cached provider "${label(config)}" failed authentication; re-detected "${label(fresh)}" and retrying once.`);
    return { result: await reviewOnce(fresh), config: fresh };
  }
}
