// Settings for the chief of staff. Keys live outside the repo (which is public) in
// %APPDATA%\desk-board\cos.json and are re-read on every call, so edits apply without a restart.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Same folder Electron's app.getPath('appData') gives, so the board and the standalone runner agree.
// Never fall back to the working directory: that could put keys inside the public repo.
const APPDATA = process.env.APPDATA
  || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'));
const DIR = path.join(APPDATA, 'desk-board');
const FILE = process.env.COS_CONFIG || path.join(DIR, 'cos.json');
const DEFAULTS = {
  vapiKey: '', vapiPhoneNumberId: '', myPhone: '', deepgramKey: '',
  jevKey: '', jevBase: '', jevModel: '', exaKey: '',
  plaidClientId: '', plaidSecret: '',
  repos: ['gouthamdeepak1705/desk-board'],
  threshold: 0.7, pollSeconds: 30, maxCallsPerHour: 6, publicUrl: '',
  ordersMode: 'auto',   // orders given on a call: 'auto' runs confirmed ones, 'ask' waits for a click, 'off' ignores them
  quietHours: '',       // like "23:00-07:00": inside them only urgency 0.9 and up rings the phone
  watches: [],          // topics to watch on the web through Exa, like "OpenAI API pricing changes" (at most 5)
  watchMinutes: 5,      // how often each topic is searched
  dailyBriefing: '',    // like "09:00": a briefing call every day at that local time
  profile: '',   // a few lines about the user, used by the standalone runner (the board uses its memory instead)
};

function cfg() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  return { ...DEFAULTS, ...saved };
}

// Write a blank settings file the first time, so there is something to paste keys into.
cfg.ensure = () => {
  if (fs.existsSync(FILE)) return FILE;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(DEFAULTS, null, 2));
  return FILE;
};
cfg.save = (patch) => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ ...cfg(), ...patch }, null, 2));
};
cfg.file = FILE;
cfg.dir = DIR;

module.exports = cfg;
