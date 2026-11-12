// Automatic updates (electron-updater).
//   - Checks shortly after Tide starts and then every 6 hours, downloads in the background and installs
//     when you restart. Failures stay quiet unless you pressed "Check for updates" yourself.
//   - The update feed is baked into the installed app by electron-builder (the "publish" setting in package.json).
//   - Each download is verified against the SHA-512 in latest.yml before it is installed.
//   - In development nothing is checked, unless TIDE_UPDATE_FEED points at a test server. That variable is
//     ignored in the installed app, so it can never be used to redirect real updates.
const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');

// Flip to true once the Mac build is signed and notarized with an Apple Developer ID.
const MAC_SIGNED = false;
const SELF_UPDATE = process.platform !== 'darwin' || MAC_SIGNED;

const state = { status: 'idle', version: '', percent: 0, error: '', kind: '', checkedAt: 0 };

// Turn a raw updater error into a sentence a person can act on.
function friendly(e) {
  const m = String((e && e.message) || e || '');
  if (/\b404\b|cannot find latest|no published versions/i.test(m)) return { kind: 'nofeed', text: 'No updates have been published yet.' };
  if (/enotfound|econnrefused|etimedout|econnreset|eai_again|err_internet|err_network|err_connection|getaddrinfo|net::/i.test(m)) return { kind: 'network', text: 'Could not reach the update server. Check your internet connection.' };
  if (/sha512|checksum/i.test(m)) return { kind: 'integrity', text: 'The downloaded update failed its safety check, so Tide discarded it.' };
  return { kind: 'other', text: 'Could not check for updates right now.' };
}
let updater = null;
let hooks = null;
let manual = false;
let supported = false;

function set(patch) {
  Object.assign(state, patch);
  if (hooks && hooks.onChange) hooks.onChange();
}

function init(opts) {
  hooks = opts;
  const testFeed = !app.isPackaged && process.env.TIDE_UPDATE_FEED;
  supported = app.isPackaged || !!testFeed;
  if (!supported) { set({ status: 'unsupported' }); return; }

  ({ autoUpdater: updater } = require('electron-updater'));
  // macOS only installs an update over a signed app. Until Tide is signed with an Apple Developer ID, a Mac
  // copy finds new versions and opens the download page instead of installing by itself.
  updater.autoDownload = SELF_UPDATE;
  // A test feed must never install anything onto this PC when the app closes.
  updater.autoInstallOnAppQuit = !testFeed;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.logger = null;
  if (testFeed) {
    updater.forceDevUpdateConfig = true;
    updater.setFeedURL({ provider: 'generic', url: testFeed });
  }

  updater.on('checking-for-update', () => set({ status: 'checking', error: '' }));
  updater.on('update-available', (info) => {
    if (!SELF_UPDATE) {
      set({ status: 'available', version: info.version, checkedAt: Date.now() });
      if (hooks.toast) hooks.toast(`Tide ${info.version} is available. Open Settings > About to download it`);
      manual = false;
      return;
    }
    set({ status: 'downloading', version: info.version, percent: 0 });
    if (hooks.toast) hooks.toast(`Downloading Tide ${info.version}`);
  });
  updater.on('update-not-available', () => {
    set({ status: 'none', checkedAt: Date.now() });
    if (manual && hooks.toast) hooks.toast('Tide is up to date');
    manual = false;
  });
  updater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  updater.on('update-downloaded', (info) => {
    set({ status: 'ready', version: info.version, percent: 100, checkedAt: Date.now() });
    if (hooks.toast) hooks.toast(`Tide ${info.version} is ready. Restart to finish updating`);
  });
  updater.on('error', (e) => {
    const f = friendly(e);
    set({ status: 'error', error: f.text, kind: f.kind, checkedAt: Date.now() });
    if (manual && hooks.toast) hooks.toast(f.kind === 'nofeed' ? 'No updates published yet' : 'Could not check for updates');
    manual = false;
  });

  setTimeout(() => check(false), testFeed ? 1500 : 45 * 1000).unref?.();
  setInterval(() => check(false), 6 * 60 * 60 * 1000).unref?.();
}

function check(byUser) {
  if (!supported || !updater) { if (byUser && hooks.toast) hooks.toast('Updates work in the installed app'); return; }
  if (['checking', 'downloading', 'ready', 'available'].includes(state.status)) return;
  manual = !!byUser;
  updater.checkForUpdates().catch(() => { /* reported through the "error" event */ });
}

// The releases page of the repository the installed app updates from (electron-builder wrote it into app-update.yml).
function releasesUrl() {
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const owner = /^owner:\s*(\S+)/m.exec(yml);
    const repo = /^repo:\s*(\S+)/m.exec(yml);
    if (owner && repo) return `https://github.com/${owner[1]}/${repo[1]}/releases/latest`;
  } catch { /* not packaged */ }
  return null;
}

function install() {
  if (state.status === 'available') { const u = releasesUrl(); if (u) shell.openExternal(u); return !!u; }
  if (state.status !== 'ready' || !updater) return false;
  if (hooks.beforeInstall) hooks.beforeInstall();
  // silent install, then Tide starts again by itself
  setImmediate(() => updater.quitAndInstall(true, true));
  return true;
}

const status = () => ({ ...state, current: app.getVersion(), supported });

module.exports = { init, check, install, status, friendly };
