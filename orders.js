// Orders given on a call, carried out after hang-up through the signed-in `gh` CLI.
// Only the fixed set of commands built below can ever run: no delete, merge, push or API write.
// Arguments go to execFile as an array (no shell). run() and check() never throw.
const { execFile } = require('child_process');

const TIMEOUT_MS = 15000;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const NUM_RE = /^\d+$/;
const TEXT_MAX = 500;
const TITLE_MAX = 200;
const FOOTER = 'Sent by phone through my chief of staff.';
const CREATED_BODY = 'Created by phone through my chief of staff.';

const ACTIONS = ['rerun_build', 'comment', 'close_issue', 'label_urgent', 'assign_me', 'create_issue', 'mute_similar', 'dispute_charge'];

const PHRASES = {
  rerun_build: 'rerun the build',
  comment: 'comment on the issue',
  close_issue: 'close the issue',
  label_urgent: 'label it urgent',
  assign_me: 'assign it to you',
  create_issue: 'open a new issue',
  mute_similar: 'stop calling about things like this',
  dispute_charge: 'flag the charge for dispute',
};

// What each action needs from the event it is about.
const NEEDS = {
  rerun_build: { kind: 'build_failed', say: 'To rerun a build I need the failed build the call was about, and there isn\'t one.' },
  comment: { kind: 'issue', say: 'To comment I need the issue the call was about, and there isn\'t one.' },
  close_issue: { kind: 'issue', say: 'To close an issue I need the issue the call was about, and there isn\'t one.' },
  label_urgent: { kind: 'issue', say: 'To label something urgent I need the issue the call was about, and there isn\'t one.' },
  assign_me: { kind: 'issue', say: 'To assign something to you I need the issue the call was about, and there isn\'t one.' },
  dispute_charge: { kind: 'charge', say: 'To flag a charge I need the charge the call was about, and there isn\'t one.' },
};

// execFile with no shell, so nothing in an argument can be read as a command.
const defaultExec = (args) => new Promise((resolve, reject) => {
  execFile('gh', args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    if (!err) return resolve(stdout);
    err.message = err.killed ? 'gh timed out' : ((stderr || '').trim() || err.message);
    reject(err);
  });
});

const describe = (action) => PHRASES[action] || 'do that';
// Control characters out; newlines kept only when asked (comment bodies).
const clean = (s, keepNewlines) => {
  let t = String(s == null ? '' : s).replace(/\r\n?/g, '\n');
  t = t.replace(keepNewlines ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g, keepNewlines ? '' : ' ');
  return keepNewlines ? t.trim() : t.replace(/\s+/g, ' ').trim();
};
const firstLine = (e) => {
  const m = String((e && e.message) || e || '').split('\n').map((l) => l.trim()).find(Boolean) || 'unknown error';
  if (e && e.code === 'ENOENT') return 'gh is not installed';
  return clean(m).slice(0, 120).replace(/[.\s]+$/, '');
};
const shortName = (repo) => String(repo).split('/')[1] || repo;

// Repo of an event: an explicit field, else the id (`gh:issue:owner/name#7`), else the url.
function repoOf(ev) {
  if (!ev || typeof ev !== 'object') return '';
  if (typeof ev.repo === 'string' && ev.repo) return ev.repo;
  let m = /^gh:(?:issue|dependabot|secret):(.+)#\d+$/.exec(String(ev.id || ''));
  if (m) return m[1];
  m = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\//.exec(String(ev.url || ''));
  return m ? m[1] : '';
}

module.exports = ({ cfg, log = () => {}, exec = defaultExec }) => {
  const allowed = (repo) => {
    if (typeof repo !== 'string' || !REPO_RE.test(repo) || repo.startsWith('-')) return false;
    let list = [];
    try { list = cfg().repos; } catch {}
    return Array.isArray(list) && list.some((r) => typeof r === 'string' && r.toLowerCase() === repo.toLowerCase());
  };
  const refuse = (result) => ({ ok: false, result, simulated: false, ref: null });

  async function run(order, event) {
    try {
      const action = order && order.action;
      if (!ACTIONS.includes(action) || action === 'mute_similar') return refuse("That isn't something I can do.");
      const ev = event && typeof event === 'object' ? event : null;
      const what = describe(action);

      // Free text, cleaned once.
      let text = '';
      if (action === 'comment') {
        text = clean(order.text, true).slice(0, TEXT_MAX).trim();
        if (!text) return refuse('I need something to say before I can comment.');
      } else if (action === 'create_issue') {
        text = clean(order.text, false).slice(0, TITLE_MAX).trim();
        if (!text) return refuse('I need a title before I can open a new issue.');
      }

      const need = NEEDS[action];
      if (need && (!ev || ev.kind !== need.kind)) return refuse(need.say);

      // Made-up data is never acted on.
      if (ev && (ev.source === 'demo' || ev.sample === true)) {
        if (action === 'dispute_charge') return disputeResult(ev);
        return { ok: true, simulated: true, result: `Simulated: I would have ${what}.`, ref: null };
      }
      if (action === 'dispute_charge') return disputeResult(ev);

      // Work out the target repo, then check it against the watched list.
      let repo = '';
      let id = '';
      if (action === 'rerun_build') {
        const rid = /^gh:run:(\d+)$/.exec(String(ev.id || ''));
        const um = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)(?:[/?#]|$)/.exec(String(ev.url || ''));
        if (!rid || !um) return refuse("I can't tell which build that was, so I didn't rerun anything.");
        repo = um[1];
        id = rid[1];
      } else if (action === 'create_issue') {
        repo = (ev && repoOf(ev)) || ((cfg().repos || [])[0]) || '';
        if (!repo) return refuse("I don't have a repository to open the issue in.");
      } else {
        const m = /^gh:issue:(.+)#(\d+)$/.exec(String(ev.id || ''));
        if (!m) return refuse("I can't tell which issue that was, so I didn't change anything.");
        repo = m[1];
        id = m[2];
      }
      if (!allowed(repo)) return refuse("That repository isn't on your watched list, so I didn't touch it.");

      const name = shortName(repo);
      const fail = (e) => ({ ok: false, simulated: false, ref: null, result: `I couldn't ${what}: ${firstLine(e)}.` });

      try {
        switch (action) {
          case 'rerun_build': {
            await exec(['run', 'rerun', id, '-R', repo, '--failed']);
            const b = /^Build failed on (.+?) in /.exec(String(ev.title || ''));
            const branch = b ? clean(b[1]).slice(0, 60) : '';
            return { ok: true, simulated: false, ref: { kind: 'run', repo, id }, result: `I restarted the failed jobs${branch ? ' on ' + branch : ''} in ${name}.` };
          }
          case 'comment':
            await exec(['issue', 'comment', id, '-R', repo, '--body=' + text + '\n\n' + FOOTER]);
            return { ok: true, simulated: false, ref: null, result: `I posted your comment on the issue in ${name}.` };
          case 'close_issue':
            await exec(['issue', 'close', id, '-R', repo]);
            return { ok: true, simulated: false, ref: null, result: `I closed the issue in ${name}.` };
          case 'label_urgent':
            await exec(['label', 'create', 'urgent', '-R', repo, '--color', 'B60205', '--force']);
            await exec(['issue', 'edit', id, '-R', repo, '--add-label', 'urgent']);
            return { ok: true, simulated: false, ref: null, result: `I labelled the issue in ${name} as urgent.` };
          case 'assign_me':
            await exec(['issue', 'edit', id, '-R', repo, '--add-assignee', '@me']);
            return { ok: true, simulated: false, ref: null, result: `I assigned the issue in ${name} to you.` };
          case 'create_issue': {
            const out = await exec(['issue', 'create', '-R', repo, '--title=' + text, '--body=' + CREATED_BODY]);
            const url = (/https:\/\/github\.com\/\S+\/issues\/\d+/.exec(String(out || '')) || [''])[0];
            const n = /\/issues\/(\d+)/.exec(url);
            return { ok: true, simulated: false, ref: { kind: 'issue', repo, url }, result: n ? `I opened issue number ${n[1]} in ${name}.` : `I opened a new issue in ${name}.` };
          }
          default:
            return refuse("That isn't something I can do.");
        }
      } catch (e) {
        log('orders: ' + action + ' failed: ' + firstLine(e));
        return fail(e);
      }
    } catch (e) {
      return refuse(`I couldn't do that: ${firstLine(e)}.`);
    }
  }

  // The card feed is sandbox data, so a dispute is only ever flagged here.
  function disputeResult(ev) {
    // Charge titles read "$12.00 charge at Merchant"; only the merchant belongs in the sentence.
    const at = /\b(?:charge at|refund from|posted at) (.+?)(?:\. |$)/.exec(`${(ev && ev.title) || ''}. ${(ev && ev.detail) || ''}`);
    const merchant = clean((ev && ev.merchant) || (at && at[1]) || 'that merchant').replace(/\.$/, '').slice(0, 60);
    return { ok: true, simulated: true, ref: null, result: `I've flagged the charge at ${merchant} for dispute. This is sandbox data, so nothing was sent to a bank.` };
  }

  async function check(order) {
    try {
      const ref = order && order.ref;
      if (!ref || ref.kind !== 'run') return null;
      if (!allowed(ref.repo) || !NUM_RE.test(String(ref.id))) return null;
      const out = await exec(['run', 'view', String(ref.id), '-R', ref.repo, '--json', 'status,conclusion']);
      const j = JSON.parse(String(out || '{}'));
      if (j.status !== 'completed') return { result: 'The rerun is still going.' };
      return { result: j.conclusion === 'success' ? 'The rerun passed.' : 'The rerun failed again.' };
    } catch {
      return null;
    }
  }

  return { run, check, describe };
};

module.exports.ACTIONS = ACTIONS;
