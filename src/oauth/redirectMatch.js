'use strict';

/**
 * Safe OAuth redirect-URI matching, with OPTIONAL single-label wildcard support.
 *
 * A registered redirect URI may use a wildcard as the LEFT-MOST DNS label only:
 *     https://*.nexoro.net/oauth/callback
 * The `*` matches EXACTLY ONE label (no dots) — so it matches
 *     https://app.nexoro.net/oauth/callback
 *     https://foo.nexoro.net/oauth/callback
 * but NOT
 *     https://a.b.nexoro.net/oauth/callback   (spans a dot)
 *     https://nexoro.net/oauth/callback        (no sub-label)
 *     https://evil.com/oauth/callback          (different base)
 *
 * Everything else must match EXACTLY: scheme, port, path, and query. This keeps
 * the redirect an OAuth security boundary — a wildcard only widens the single
 * sub-domain label of ONE registered host, nothing else. Non-wildcard entries
 * are compared by exact string equality (after URL normalization).
 */

/** Is this registered URI a valid single-left-label wildcard pattern? */
function isWildcardPattern(registered) {
  // Must contain exactly one '*', and it must be the start of the host:
  //   scheme://*.rest-of-host[/path...]
  // We reject '*' anywhere in scheme/port/path/query.
  const m = /^https:\/\/\*\.([^*/?#:@]+)(:\d+)?(\/[^*]*)?$/.exec(registered);
  if (!m) return false;
  // The base host (after '*.') must itself have at least one dot, so a pattern
  // like https://*.com (matching any *.com) is rejected — too broad.
  const baseHost = m[1];
  if (!baseHost.includes('.')) return false;
  // No further '*' allowed anywhere (regex already forbids it in path).
  return true;
}

/**
 * Does an incoming redirect URI match a single registered pattern (which may be
 * exact or a wildcard)? Returns true/false. Never throws.
 */
function matchesOne(registered, incoming) {
  if (typeof registered !== 'string' || typeof incoming !== 'string') return false;

  if (!isWildcardPattern(registered)) {
    // Exact match (both are already normalized via new URL().toString() on save;
    // normalize the incoming the same way for a fair comparison).
    let inc;
    try { inc = new URL(incoming).toString(); } catch { return incoming === registered; }
    return inc === registered || incoming === registered;
  }

  // Wildcard pattern. Parse both and compare component-by-component.
  let reg, inc;
  try {
    // Replace '*.' with a placeholder label so URL() can parse the pattern.
    reg = new URL(registered.replace('://*.', '://__wildcard__.'));
    inc = new URL(incoming);
  } catch { return false; }

  // Scheme, port, path, and query+hash must match EXACTLY.
  if (reg.protocol !== inc.protocol) return false;
  if (reg.port !== inc.port) return false;
  if (reg.pathname !== inc.pathname) return false;
  if (reg.search !== inc.search) return false;
  if (reg.hash !== inc.hash) return false;

  // Host: the registered host is "__wildcard__.<baseHost>". The incoming host
  // must be "<one-label>.<baseHost>" with exactly one extra label and no dots
  // in that label.
  const baseHost = reg.hostname.replace(/^__wildcard__\./, '');
  const suffix = '.' + baseHost;
  const incHost = inc.hostname.toLowerCase();
  if (!incHost.endsWith(suffix)) return false;
  const label = incHost.slice(0, -suffix.length);
  if (label === '' || label.includes('.')) return false; // exactly one non-empty label
  return true;
}

/** Does `incoming` match ANY of the client's registered redirect URIs? */
function redirectUriMatches(registeredList, incoming) {
  if (!Array.isArray(registeredList)) return false;
  return registeredList.some((r) => matchesOne(r, incoming));
}

module.exports = { redirectUriMatches, isWildcardPattern, matchesOne };
