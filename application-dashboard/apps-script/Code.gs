/**
 * Application Dashboard — Background Gmail Sync
 *
 * Runs in your Google account on a time trigger (default: every 15 min).
 * Scans Gmail for application-lifecycle keywords, normalizes each
 * thread, caches the result in ScriptProperties, and exposes a small
 * secret-protected GET endpoint the dashboard can pull from.
 *
 * One-time setup
 * --------------
 * 1. Open https://script.google.com → New project. Paste this file's
 *    contents into Code.gs (replace the default function).
 * 2. Save (disk icon). Give the project a name like
 *    "Application Dashboard Sync".
 * 3. Run the `setup()` function once (top toolbar → select setup → Run).
 *    - First run prompts for Gmail read permission. Approve.
 *    - You'll see the "unverified app" warning because YOUR own
 *      Apps Script project hasn't been verified by Google. Click
 *      "Advanced" → "Go to ... (unsafe)" → continue.
 *    - The Logs (View → Executions / Logs) print your shared SECRET.
 *      Copy it.
 * 4. Deploy → New deployment → ⚙ → Web app
 *    - Description: anything
 *    - Execute as: Me (your Gmail account)
 *    - Who has access: Anyone
 *    - Click Deploy. Approve any further permission prompts.
 *    - Copy the Web app URL (ends with /exec).
 * 5. In the dashboard's Gmail Sync view, paste BOTH the Web app URL
 *    and the SECRET into the "Background Sync" panel.
 *
 * Dashboard fetches `<URL>?action=results&token=<SECRET>` and gets back:
 *   { scannedAt, threads: [ { threadId, messageId, internalDate,
 *                             subject, from, date, snippet }, ... ] }
 *
 * Privacy
 * -------
 * - Script runs as YOU. It only ever reads your own inbox.
 * - The shared secret is the auth boundary for the web endpoint.
 *   Treat it like a password (if leaked, regenerate via setup()).
 * - "Who has access: Anyone" means the URL is reachable by anyone,
 *   but the secret check rejects everything else.
 */

const SCAN_QUERY =
  '"thank you for applying" OR "application received" OR "we received your application" ' +
  'OR "thank you for your interest" OR "your application" ' +
  'OR "interview" OR "phone screen" OR "online assessment" OR "coding challenge" OR "take-home" OR "take home" ' +
  'OR "unfortunately" OR "not selected" OR "move forward with other" OR "decided not to" ' +
  'OR "not moving forward" OR "no longer considering" ' +
  'OR "extend an offer" OR "pleased to extend" OR "offer of employment"';

const WINDOW_DAYS = 90;
const MAX_THREADS = 200;
const TRIGGER_MINUTES = 15;

/**
 * One-time bootstrap. Generates a shared secret, installs the
 * 15-minute trigger, runs an initial scan to warm the cache.
 * Re-running is safe — it reuses the existing secret and replaces the
 * trigger.
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('SECRET', secret);
  }
  // Replace any existing trigger so we don't end up with duplicates.
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'scanInbox') {
      ScriptApp.deleteTrigger(t);
    }
  }
  ScriptApp.newTrigger('scanInbox').timeBased().everyMinutes(TRIGGER_MINUTES).create();
  scanInbox();
  Logger.log('=========================================================');
  Logger.log('Setup complete.');
  Logger.log('Shared SECRET: %s', secret);
  Logger.log('Trigger: scanInbox() every %s minutes.', TRIGGER_MINUTES);
  Logger.log('Next: Deploy → New deployment → Web app, "Anyone" access,');
  Logger.log('then paste the Web app URL + SECRET into the dashboard.');
  Logger.log('=========================================================');
}

/**
 * Print the secret again (e.g., if you lost it before pasting it).
 * Generates a new one only if none exists.
 */
function showSecret() {
  const s = PropertiesService.getScriptProperties().getProperty('SECRET');
  Logger.log(s ? ('Shared SECRET: ' + s) : 'No secret yet — run setup() first.');
}

/**
 * Rotate the secret (invalidates the old one). Use if you think it
 * leaked. After rotating, re-paste into the dashboard.
 */
function rotateSecret() {
  const s = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('SECRET', s);
  Logger.log('New SECRET: ' + s);
}

/**
 * Walks recent matching threads, returns a flat object per thread.
 * Called by the time trigger and on demand from the web endpoint.
 */
function scanInbox() {
  const q = SCAN_QUERY + ' newer_than:' + WINDOW_DAYS + 'd';
  const threads = GmailApp.search(q, 0, MAX_THREADS);
  const out = [];
  for (const thread of threads) {
    try {
      const messages = thread.getMessages();
      const last = messages[messages.length - 1];
      const body = (last.getPlainBody() || '').replace(/\s+/g, ' ').trim();
      out.push({
        threadId: thread.getId(),
        messageId: last.getId(),
        internalDate: last.getDate().getTime(),
        subject: last.getSubject() || '',
        from: last.getFrom() || '',
        date: last.getDate().toISOString(),
        snippet: body.slice(0, 240)
      });
    } catch (e) { /* skip individual failures, keep going */ }
  }
  const payload = { scannedAt: new Date().toISOString(), threads: out };
  PropertiesService.getScriptProperties().setProperty('LAST_SCAN', JSON.stringify(payload));
  return payload;
}

/**
 * Web app entry point.
 *   ?action=ping     → { ok: true }     (auth-checked)
 *   ?action=results  → cached scan      (default)
 *   ?action=rescan   → forces fresh scan
 * All actions require ?token=<SECRET>.
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = params.action || 'results';
  const props = PropertiesService.getScriptProperties();
  const expected = props.getProperty('SECRET');

  if (!expected || !params.token || params.token !== expected) {
    return _json({ error: 'unauthorized' });
  }

  if (action === 'ping') {
    return _json({ ok: true, scannedAt: (JSON.parse(props.getProperty('LAST_SCAN') || '{}')).scannedAt || null });
  }
  if (action === 'rescan') {
    return _json(scanInbox());
  }
  // Default: results
  const cached = props.getProperty('LAST_SCAN');
  if (cached) return _json(JSON.parse(cached));
  return _json(scanInbox());
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
