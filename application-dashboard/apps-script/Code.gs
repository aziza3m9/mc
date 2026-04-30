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
// Salary regex patterns we run over the FULL plain-text body (Apps
// Script side has unrestricted access to it). We collect the matched
// strings and pass them to the dashboard as `salaryRaw` so the
// client-side parser sees them — no need to ship the whole body.
const SALARY_PATTERNS = [
  /\$\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:k|K)?\s*[-–—]\s*\$?\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:k|K)?/g,
  /\$?\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?\s*(?:k|K)?\s*(?:to|-|–|—)\s*\$?\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?\s*(?:k|K)?/g,
  /up to\s*\$\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:k|K)?/gi,
  /starting at\s*\$\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:k|K)?/gi,
  /(?:salary|compensation|base|total comp(?:ensation)?|pay|pays)\s*[:=]?\s*\$\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:k|K)?/gi
];

function extractSalaryRaw(body) {
  if (!body) return '';
  const hits = [];
  for (const re of SALARY_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) !== null) hits.push(m[0]);
  }
  // Cap to avoid huge payloads if the email is filled with prices.
  return hits.slice(0, 6).join(' | ');
}

// ----- Company / role extraction --------------------------------------
// Indeed and LinkedIn confirmation emails ship the actual employer in
// the BODY, not the subject. The from-header display name ("Indeed
// Apply", "LinkedIn", "ZipRecruiter") is the platform, not the
// company, so we have to look in the body. We also try to surface a
// real job title even when the subject is generic.

const PLATFORM_NAME_RE = /^(indeed|linkedin|ziprecruiter|glassdoor|monster|dice|workday|greenhouse|lever|ashby|noreply|no-?reply|jobs|hiring|careers|apply|gmail|google|google\s+(?:play|workspace|account|cloud|for|notifications)|the\s+team)\b/i;

// Senders we never want to ingest — these are infrastructure / account
// notifications from Google itself, not job applications, even if their
// bodies happen to contain words like "your application".
const NOISE_SENDER_RE = /@(google\.com|googlemail\.com|accounts\.google\.com|googleplay\.com|firebase\.google\.com|googleusercontent\.com)/i;

function _isPlatformWord(s) {
  return !s || PLATFORM_NAME_RE.test(s.trim());
}

function _cleanCompany(s) {
  s = (s || '').trim().replace(/^["']|["']$/g, '');
  s = s.replace(/[.,!?;:]+$/, '').trim();
  // Strip trailing "team" / "careers" / etc. without losing legit names like "X Inc"
  s = s.replace(/\s+(team|careers|hr|recruiting|talent acquisition|hiring|talent)$/i, '').trim();
  if (s.length > 80) s = s.slice(0, 80);
  return s;
}

function _cleanRole(s) {
  s = (s || '').trim().replace(/^["']|["']$/g, '');
  s = s.replace(/[.,!?;:]+$/, '').trim();
  // Strip trailing " at <Company>" if a role pattern bled into it.
  s = s.replace(/\s+(?:at|with|@)\s+.{1,80}$/i, '').trim();
  if (s.length > 100) s = s.slice(0, 100);
  return s;
}

function extractCompanyHint(subject, body, fromDisplay) {
  const s = (subject || '');
  const b = (body || '');
  const text = (s + ' \n ' + b);
  let m;

  // LinkedIn: "Your application was sent to <Company>"
  m = s.match(/Your application was sent to\s+(.+?)(?:\s+for\s+|\s*$)/i);
  if (m && !_isPlatformWord(m[1])) return _cleanCompany(m[1]);

  // "Thank you for applying to <Company>"
  m = text.match(/(?:thank you for applying|thanks for applying|thank you for your interest in)\s+(?:to\s+)?(?:the\s+)?(.+?)(?:[.,!]|\s+for the\b|\s+team\b|\s+·|\s+\|)/i);
  if (m && !_isPlatformWord(m[1])) return _cleanCompany(m[1]);

  // "<Company> received your application" (start of body)
  m = b.match(/^\s*([A-Z][A-Za-z0-9 &'.\-,#]+?)\s+(?:received|has received|got|just received)\s+your application/);
  if (m && !_isPlatformWord(m[1])) return _cleanCompany(m[1]);

  // "your application to <Company>"
  m = text.match(/your application (?:to|with)\s+(.+?)(?:[.,!]|\s+for\s+|\s+has\s+|\s+is\s+|\s+team\b)/i);
  if (m && !_isPlatformWord(m[1])) return _cleanCompany(m[1]);

  // "<Title> position at <Company>" / "role at <Company>"
  m = text.match(/(?:position|role|job|opening|opportunity)\s+at\s+(.+?)(?:[.,!]|\s+team\b|\s+is\s+|\s+has\s+|\s+via\b)/i);
  if (m && !_isPlatformWord(m[1])) return _cleanCompany(m[1]);

  // "applied to[:] <…> at <Company>" — handles "You applied to: Foo at Bar"
  m = text.match(/applied (?:to|for)\s*:?\s*[^.\n]{2,80}? at\s+(.+?)(?:[.,!]|\s+via\b|\s+team\b|\s+·)/i);
  if (m && !_isPlatformWord(m[1])) return _cleanCompany(m[1]);

  // "interview (?:with|at|for) … at <Company>" / "interview with <Company>"
  m = text.match(/interview\s+(?:with|at)\s+(.+?)(?:[.,!]|\s+for\b|\s+team\b|\s+·)/i);
  if (m && !_isPlatformWord(m[1])) return _cleanCompany(m[1]);

  // "<Title> at <Company>" near top of body — fallback
  m = b.match(/^[^.\n]{0,80}?\b(?:at|with)\s+([A-Z][\w&'.\-,# ]{1,60}?)(?:[.,!]|\s+via\b|\s+team\b|\s+·)/);
  if (m && !_isPlatformWord(m[1])) return _cleanCompany(m[1]);

  // "<Company> · <Location>" pattern (Indeed/LinkedIn job-card lines)
  m = b.match(/([A-Z][\w&'.\-,# ]{1,60}?)\s*[·•|]\s*(?:[A-Z][a-z]+[\w, ]*|Remote|Hybrid|United States|Onsite|Full[\s-]?Time|Part[\s-]?Time)/);
  if (m && !_isPlatformWord(m[1])) return _cleanCompany(m[1]);

  return '';
}

function extractRoleHint(subject, body) {
  const s = (subject || '');
  const b = (body || '');
  const text = (s + ' \n ' + b);
  let m;

  // "Indeed Apply: <Title>" / "Application sent: <Title>"
  m = s.match(/^\s*(?:Indeed Apply|Indeed Application|Application sent|Your application)\s*[:\-–—]\s*(.+?)\s*$/i);
  if (m) {
    let r = m[1].replace(/\s+via\s+(?:Indeed|LinkedIn|ZipRecruiter).*$/i, '');
    return _cleanRole(r);
  }

  // "applied to / applying for the <Title> position|role|job".
  // [^.;:] keeps us inside one sentence (so we don't drag in a
  // following clause like "...for the X position. We received...").
  m = text.match(/(?:applied (?:to|for)|applying (?:to|for)|application (?:to|for))\s+(?:the\s+)?([^.;:\n]{2,80}?)\s+(?:position|role|job|opportunity|opening)\b/i);
  if (m) return _cleanRole(m[1]);

  // "for the <Title> role" / "for our <Title> position" — no "at <Company>" required
  m = text.match(/\bfor (?:the|our)\s+([^.;:\n]{2,80}?)\s+(?:position|role|opening|opportunity)\b/i);
  if (m) return _cleanRole(m[1]);

  // "the <Title> position|role at <Company>"
  m = text.match(/\bthe\s+([^.;:\n]{2,80}?)\s+(?:position|role|job|opening)\s+at\s+/i);
  if (m) return _cleanRole(m[1]);

  // "Application for: <Title>" / "Application for <Title>"
  m = text.match(/application for:?\s+([^.;:\n]+?)(?:[.\n]|\s+at\s+|\s+·\s+|\s+\|\s+|\s+with\s+)/i);
  if (m) return _cleanRole(m[1]);

  // "You applied to: <Title>" (Indeed body)
  m = text.match(/you applied to:?\s+([^.;:\n]+?)(?:[.\n]|\s+at\s+|\s+·\s+|\s+\|\s+|\s+via\b)/i);
  if (m) return _cleanRole(m[1]);

  // "interview for the <Title>"
  m = text.match(/interview for (?:the\s+)?([^.;:\n]+?)(?:[.,!]|\s+role\b|\s+position\b|\s+opportunity\b|\s+at\b)/i);
  if (m) return _cleanRole(m[1]);

  return '';
}

function scanInbox() {
  const q = SCAN_QUERY + ' newer_than:' + WINDOW_DAYS + 'd';
  const threads = GmailApp.search(q, 0, MAX_THREADS);
  const out = [];
  for (const thread of threads) {
    try {
      const messages = thread.getMessages();
      const last = messages[messages.length - 1];
      const from = last.getFrom() || '';
      // Skip Google/Gmail-system senders — they aren't job applications
      // even if their bodies happen to match a keyword.
      if (NOISE_SENDER_RE.test(from)) continue;
      const body = (last.getPlainBody() || '').replace(/\s+/g, ' ').trim();
      const subject = last.getSubject() || '';
      out.push({
        threadId: thread.getId(),
        messageId: last.getId(),
        internalDate: last.getDate().getTime(),
        subject: subject,
        from: from,
        date: last.getDate().toISOString(),
        snippet: body.slice(0, 240),
        salaryRaw: extractSalaryRaw(body),
        companyHint: extractCompanyHint(subject, body, from),
        roleHint: extractRoleHint(subject, body)
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
