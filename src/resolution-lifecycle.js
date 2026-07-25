import { configureLLM, builderContextKey } from "./llm.js";
import { withResolution, resolutionMatches, withoutCacheEntry, mutateConfigFile } from "./config-store.js";
import { log } from "./utils.js";

// Shared provider-resolution lifecycle (T21), used by the normal review path and
// BOTH loop paths so cache success-persistence and stale-provider recovery behave
// identically everywhere.

const label = (c) => `${c.provider}${c.cliCmd ? `:${c.cliCmd}` : ""}`;

const AUTH_RE = /\b(401|403)\b|unauthorized|forbidden|authentication|not logged in|invalid api key|api key.*(invalid|expired)|please (run )?login|session (has )?expired|log ?in to/;
// Invalid / retired / unsupported model — the cached resolution's model is dead.
const MODEL_RE = /\b404\b|model[^.]*\b(not found|does not exist|is invalid|unknown|unsupported|retired|deprecated|decommissioned|unavailable)\b|(unknown|invalid|unsupported|unavailable|nonexistent) model|no such model/;

// A failure meaning the cached RESOLUTION is dead — its credential is revoked/
// expired (auth) or its model is retired/invalid — as opposed to a transient
// network/5xx or a content/parse error, which must NOT invalidate the cache.
// API errors surface as a preserved status (401/403 auth, 404 not-found, or 400
// whose body names a model problem); a CLI session/model failure only as text.
export function isStaleResolutionFailure(err) {
  const text = `${err?.message || ""}\n${err?.stderr ? String(err.stderr) : ""}`.toLowerCase();
  if (typeof err?.status === "number") {
    if (err.status === 401 || err.status === 403 || err.status === 404) return true;
    if (err.status === 400) return MODEL_RE.test(text); // 400 only when it names a model issue
    return false; // 429 / 5xx / other → transient, keep the cache
  }
  return AUTH_RE.test(text) || MODEL_RE.test(text);
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
    if (!config._fromCache || !isStaleResolutionFailure(err)) throw err;
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
      log.warn(`Cached provider "${label(config)}" failed (stale credential or model); removed the stale cache entry (next run re-detects). No alternative provider is available.`);
      throw err;
    }
    log.warn(`Cached provider "${label(config)}" failed (stale credential or model); re-detected "${label(fresh)}" and retrying once.`);
    return { result: await reviewOnce(fresh), config: fresh };
  }
}
