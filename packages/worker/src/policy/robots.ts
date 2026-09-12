/**
 * robots.txt, parsed the way the standard says rather than the way it looks.
 *
 * RFC 9309. The rules that catch people out, and that the tests below pin:
 *
 *   - The *most specific* matching user-agent group wins, and only that group applies.
 *     A file with rules for `*` and rules for `LedgerOfWork` gives us only the latter,
 *     including when the latter is more permissive.
 *   - Within a group, the **longest matching path** wins, not the first.
 *   - On an equal-length tie, `Allow` beats `Disallow`.
 *   - `Disallow:` with nothing after it means *allow everything* — it is the standard way
 *     to say "no restrictions", and reading it as "disallow /" would refuse every site
 *     that uses it, which includes whitehouse.gov.
 *   - `*` matches any run of characters and `$` anchors the end.
 *
 * Nothing here fetches. The parser is pure so it can be tested against the real files of
 * sites we have no business calling from a unit test.
 */

export interface RobotsRules {
  /** Longest-match rules for the group that applies to us. */
  rules: Array<{ allow: boolean; path: string }>;
  /** Present when the file asked crawlers to wait between requests. */
  crawlDelaySeconds?: number;
}

/** Parse a robots.txt body, selecting the group that applies to `userAgent`. */
export function parseRobots(body: string, userAgent: string): RobotsRules {
  const me = userAgent.toLowerCase();

  // Collect every group, keyed by the agents it names. A group's rules begin after its
  // last consecutive User-agent line; a User-agent line following rules starts a new one.
  const groups: Array<{ agents: string[]; rules: RobotsRules["rules"]; delay?: number }> = [];
  let current: (typeof groups)[number] | null = null;
  let expectingAgents = false;

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.split("#")[0]!.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!current || !expectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
        expectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue;
    expectingAgents = false;

    if (field === "disallow") {
      // An empty value is "no restriction", not "everything". Recording it as a rule at
      // all would be wrong: it must not out-rank a real Allow elsewhere in the group.
      if (value !== "") current.rules.push({ allow: false, path: value });
    } else if (field === "allow") {
      if (value !== "") current.rules.push({ allow: true, path: value });
    } else if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }

  // Most specific wins: an exact name beats `*`, and among names the longest match beats
  // a shorter one, so `ledgerofwork-bot` is preferred over `ledgerofwork`.
  let best: (typeof groups)[number] | undefined;
  let bestScore = -1;
  for (const group of groups) {
    for (const agent of group.agents) {
      const score = agent === "*" ? 0 : me.includes(agent) ? agent.length : -1;
      if (score > bestScore) {
        bestScore = score;
        best = group;
      }
    }
  }

  if (!best) return { rules: [] };
  return {
    rules: best.rules,
    ...(best.delay === undefined ? {} : { crawlDelaySeconds: best.delay }),
  };
}

/** Turn a robots.txt path pattern into a regular expression anchored at the start. */
function patternToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") out += ".*";
    else if (c === "$" && i === pattern.length - 1) out += "$";
    else out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}`);
}

/**
 * How long a pattern matches for, for the longest-match rule.
 *
 * The standard compares the length of the *pattern*, not of the text it matched, which
 * is what makes `/x/` beat `/x` on `/x/y` and why this is not simply the match length.
 */
function specificity(pattern: string): number {
  return pattern.replace(/\$$/, "").length;
}

/** May we fetch this path? `path` should include the query string, as robots.txt matches it. */
export function isAllowed(rules: RobotsRules, path: string): { allowed: true } | { allowed: false; rule: string } {
  let winner: { allow: boolean; path: string } | null = null;
  for (const rule of rules.rules) {
    if (!patternToRegExp(rule.path).test(path)) continue;
    if (
      !winner ||
      specificity(rule.path) > specificity(winner.path) ||
      // Equal length: Allow wins, per the standard.
      (specificity(rule.path) === specificity(winner.path) && rule.allow && !winner.allow)
    ) {
      winner = rule;
    }
  }

  if (!winner || winner.allow) return { allowed: true };
  return { allowed: false, rule: `Disallow: ${winner.path}` };
}

/**
 * What to do when robots.txt could not be read.
 *
 * The standard distinguishes these and so do we, because they mean opposite things. A
 * 404 means the site has no restrictions to state; a 403 or a 500 means it has something
 * to say and we could not hear it, and guessing "allowed" there is how a crawler ends up
 * ignoring a site that was trying to refuse it.
 */
export function rulesForStatus(status: number): { rules: RobotsRules } | { refuse: string } {
  if (status >= 200 && status < 300) return { rules: { rules: [] } }; // caller parses the body
  if (status === 404 || status === 410) return { rules: { rules: [] } };
  if (status >= 400 && status < 500) {
    return { refuse: `robots.txt returned ${status} — the site is refusing to say, so neither will we` };
  }
  return { refuse: `robots.txt returned ${status} — could not read the site's rules` };
}
