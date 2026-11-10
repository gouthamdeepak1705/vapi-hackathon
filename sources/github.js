// Event source: GitHub, through the already signed-in `gh` CLI. No token is handled here and
// nothing goes through a shell. poll() never throws; problems are kept for health().
const { execFile } = require('child_process');

const TIMEOUT_MS = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;
const OFF_RETRY_MS = 30 * 60 * 1000; // a switched-off feature is looked at again after this long
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const RATE_LIMIT = /rate limit/i;
const NOT_SIGNED_IN = /gh auth login|not logged in|HTTP 401|bad credentials/i;
// Feature off for this repo (or not ours to see): not a problem, just nothing to report.
const SWITCHED_OFF = /HTTP 40[34]|disabled|not enabled|not found|not accessible/i;

const RUN_FIELDS = 'databaseId,displayTitle,workflowName,headBranch,conclusion,createdAt,url,event';
const ISSUE_FIELDS = 'number,title,body,createdAt,url,author,labels';

// execFile with no shell, so repo names and query strings can never be interpreted as commands.
const defaultExec = (args) => new Promise((resolve, reject) => {
  execFile('gh', args, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    if (!err) return resolve(stdout);
    err.message = err.killed ? 'gh timed out' : ((stderr || '').trim() || err.message);
    reject(err);
  });
});

const arr = (x) => (Array.isArray(x) ? x : []);
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const iso = (t) => { const d = new Date(t); return isNaN(d) ? new Date().toISOString() : d.toISOString(); };
// API address of a notification's subject -> the page a person would open
const webUrl = (u) => String(u || '').replace('https://api.github.com/repos/', 'https://github.com/').replace('/pulls/', '/pull/');

module.exports = ({ cfg, log = () => {}, exec = defaultExec }) => {
  const offUntil = new Map(); // feature key -> time we may try again
  let status = 'ok';

  // One gh call, parsed. Returns null on any failure; the reason goes into `errors` unless the
  // feature is simply off (remembered) or the call is `soft` (best effort).
  async function gh(key, args, errors, soft) {
    if ((offUntil.get(key) || 0) > Date.now()) return null;
    try {
      const out = await exec(args);
      return out && String(out).trim() ? JSON.parse(out) : [];
    } catch (e) {
      const m = String((e && e.message) || e);
      if (soft) return null;
      if (e && e.code === 'ENOENT') errors.push('gh is not installed');
      else if (RATE_LIMIT.test(m)) errors.push('GitHub rate limit reached');
      else if (NOT_SIGNED_IN.test(m)) errors.push('gh is not signed in');
      else if (SWITCHED_OFF.test(m)) { offUntil.set(key, Date.now() + OFF_RETRY_MS); log('github: skipping ' + key); }
      else errors.push(clip(m.split('\n')[0], 80));
      return null;
    }
  }

  async function pollRepo(repo, errors) {
    const name = repo.split('/')[1];
    const since = Date.now() - DAY_MS;
    const fresh = (t) => Date.parse(t) >= since;
    const [runs, issues, deps, secrets] = await Promise.all([
      gh(repo + ':runs', ['run', 'list', '-R', repo, '--status', 'failure', '--limit', '5', '--json', RUN_FIELDS], errors),
      gh(repo + ':issues', ['issue', 'list', '-R', repo, '--state', 'open', '--limit', '10', '--json', ISSUE_FIELDS], errors),
      gh(repo + ':dependabot', ['api', `repos/${repo}/dependabot/alerts?state=open&per_page=10`], errors),
      gh(repo + ':secrets', ['api', `repos/${repo}/secret-scanning/alerts?state=open&per_page=10`], errors),
    ]);
    const out = [];

    for (const r of arr(runs)) {
      if (!fresh(r.createdAt)) continue;
      out.push({
        id: `gh:run:${r.databaseId}`, source: 'github', kind: 'build_failed',
        title: `Build failed on ${r.headBranch || 'a branch'} in ${name}: ${clip(r.displayTitle || r.workflowName, 120)}`,
        detail: clip(`Workflow ${r.workflowName || 'unknown'}, triggered by ${r.event || 'unknown'} on ${r.headBranch || 'unknown'}.`, 600),
        url: r.url, ts: iso(r.createdAt), sample: false, repo,
      });
    }

    for (const i of arr(issues)) {
      if (!fresh(i.createdAt)) continue;
      const who = (i.author && i.author.login) || 'unknown';
      const head = `Opened by ${who}: `;
      out.push({
        id: `gh:issue:${repo}#${i.number}`, source: 'github', kind: 'issue',
        title: `New issue in ${name}: ${clip(i.title, 120)}`,
        detail: head + clip(i.body, 600 - head.length),
        url: i.url, ts: iso(i.createdAt), sample: false, repo,
      });
    }

    for (const a of arr(deps)) {
      const adv = a.security_advisory || {};
      const pkg = (a.dependency && a.dependency.package) || {};
      const sev = adv.severity || (a.security_vulnerability && a.security_vulnerability.severity) || 'unknown';
      const ids = [adv.ghsa_id, adv.cve_id].filter(Boolean).join(' / ') || 'no advisory id';
      out.push({
        id: `gh:dependabot:${repo}#${a.number}`, source: 'github', kind: 'security_alert',
        title: `${cap(sev)} severity security alert in ${name}: ${pkg.name || 'a dependency'}`,
        detail: clip(`Package ${pkg.name || 'unknown'} (${pkg.ecosystem || 'unknown'}), severity ${sev}, ${ids}. ${adv.summary || ''}`, 600),
        url: a.html_url, ts: iso(a.created_at), sample: false, repo,
      });
    }

    // Only the type and where it sits are copied; the secret value is never read into an event.
    const found = await Promise.all(arr(secrets).map(async (a) => {
      const locs = await gh(repo + ':secretloc', ['api', `repos/${repo}/secret-scanning/alerts/${a.number}/locations`], errors, true);
      const d = (arr(locs)[0] || {}).details || {};
      const where = d.path ? d.path + (d.start_line ? ':' + d.start_line : '') : 'location not available';
      const type = a.secret_type_display_name || a.secret_type || 'secret';
      return {
        id: `gh:secret:${repo}#${a.number}`, source: 'github', kind: 'security_alert',
        title: `Exposed ${type} found in ${name}`,
        detail: clip(`Secret scanning found a ${type} in ${repo}. Location: ${where}.`, 600),
        url: a.html_url, ts: iso(a.created_at), sample: false, repo,
      };
    }));
    return out.concat(found);
  }

  // One call per poll, not per repo.
  async function pollNotifications(errors) {
    const list = await gh('notifications', ['api', 'notifications?per_page=20'], errors);
    return arr(list).map((n) => {
      const s = n.subject || {};
      const repo = (n.repository && n.repository.full_name) || '';
      const short = repo.split('/')[1] || repo;
      const kind = n.reason === 'review_requested' ? 'review_request'
        : (n.reason === 'mention' || n.reason === 'team_mention') ? 'mention' : 'notification';
      const lead = kind === 'review_request' ? 'Review requested in' : kind === 'mention' ? 'You were mentioned in' : 'Notification from';
      return {
        id: `gh:notif:${n.id}`, source: 'github', kind,
        title: `${lead} ${short}: ${clip(s.title, 120)}`,
        detail: clip(`${s.type || 'Item'} in ${repo}, reason: ${String(n.reason || 'unknown').replace(/_/g, ' ')}.`, 600),
        url: webUrl(s.url) || (n.repository && n.repository.html_url) || undefined,
        ts: iso(n.updated_at), sample: false, repo, subjectUrl: s.url || '', subjectType: s.type || '',
      };
    });
  }

  async function poll() {
    const errors = [];
    let events = [];
    try {
      const repos = arr(cfg().repos).filter((r) => typeof r === 'string' && REPO_RE.test(r));
      if (!repos.length) { status = 'off'; return []; }
      const [perRepo, notifs] = await Promise.all([
        Promise.all(repos.map((r) => pollRepo(r, errors).catch((e) => { errors.push(clip(e && e.message, 80)); return []; }))),
        pollNotifications(errors).catch((e) => { errors.push(clip(e && e.message, 80)); return []; }),
      ]);
      events = perRepo.flat();
      // A notification that only repeats an issue or failed run we already have adds nothing.
      const issueKeys = new Set(events.filter((e) => e.kind === 'issue').map((e) => e.id.slice('gh:issue:'.length)));
      const failedRepos = new Set(events.filter((e) => e.kind === 'build_failed').map((e) => e.repo));
      for (const n of notifs) {
        const m = /\/issues\/(\d+)$/.exec(n.subjectUrl);
        if (m && issueKeys.has(`${n.repo}#${m[1]}`)) continue;
        if (n.subjectType === 'CheckSuite' && failedRepos.has(n.repo)) continue;
        events.push(n);
      }
      for (const e of events) { delete e.repo; delete e.subjectUrl; delete e.subjectType; }
      events.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    } catch (e) {
      errors.push(clip(e && e.message, 80) || 'unexpected failure');
    }
    status = errors.length ? 'error: ' + errors[0] : 'ok';
    return events;
  }

  function health() {
    try { if (!arr(cfg().repos).length) return 'off'; } catch {}
    return status;
  }

  return { name: 'github', poll, health };
};
