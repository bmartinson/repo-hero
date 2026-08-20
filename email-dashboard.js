const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const resultsDir = path.join(__dirname, '.results_history');
const dashboardFile = path.join(resultsDir, 'dashboard.html');
const configFile = path.join(__dirname, 'config.json');

// Most providers reject messages larger than 25 MB, and base64 inflates an
// attachment by roughly a third. Warn well before the wire size gets there.
const DEFAULT_MAX_ATTACHMENT_MB = 20;
const BASE64_OVERHEAD = 4 / 3;

const formatSize = bytes => {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
};

// ─── Config ─────────────────────────────────────────────────────────────────

/**
 * Reads config.json from disk. Returns an empty object when it is missing or
 * unparseable so a bad config degrades to "email not configured" rather than
 * taking down the dashboard run.
 */
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Accepts either a single address or a list of them and returns a de-duplicated
 * array of trimmed, non-empty addresses.
 *
 * @param {string|string[]|undefined} value raw recipient value from config
 * @returns {string[]} normalized recipient list
 */
function normalizeRecipients(value) {
  if (!value) return [];

  const list = Array.isArray(value) ? value : [value];
  const seen = new Set();

  return list
    .filter(entry => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(entry => {
      if (!entry) return false;

      const key = entry.toLowerCase();
      if (seen.has(key)) return false;

      seen.add(key);

      return true;
    });
}

/**
 * A permissive check that catches typos and obviously malformed entries without
 * trying to fully implement RFC 5322. Supports both "user@host" and the
 * "Display Name <user@host>" form nodemailer accepts.
 *
 * @param {string} address address to test
 * @returns {boolean} whether the address is plausibly deliverable
 */
function isValidAddress(address) {
  const bracketed = address.match(/<([^>]+)>\s*$/);
  const bare = bracketed ? bracketed[1].trim() : address;

  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(bare);
}

/**
 * Validates the `email` config block and its `tokens.smtp` credentials.
 *
 * Email delivery is opt-in: a config with no `email` block resolves as disabled
 * with no warnings. A config that is present but unusable resolves as disabled
 * *with* warnings, so a typo is reported rather than silently dropping the
 * report.
 *
 * @param {object} config parsed config.json
 * @returns {{enabled: boolean, warnings: string[], settings: object|null}} resolution
 */
function resolveEmailConfig(config) {
  const warnings = [];
  const email = config?.email;

  if (!email || typeof email !== 'object') {
    return { enabled: false, warnings, settings: null };
  }

  if (email.enabled === false) {
    return { enabled: false, warnings, settings: null };
  }

  const to = normalizeRecipients(email.to);
  const cc = normalizeRecipients(email.cc);
  const bcc = normalizeRecipients(email.bcc);
  const smtp = email.smtp || {};
  const credentials = config?.tokens?.smtp || {};

  if (to.length === 0) {
    warnings.push('"email.to" must list at least one recipient address.');
  }

  [...to, ...cc, ...bcc].forEach(address => {
    if (!isValidAddress(address)) {
      warnings.push(`"${address}" is not a valid email address.`);
    }
  });

  if (!smtp.host) {
    warnings.push('"email.smtp.host" is required.');
  }

  if (!credentials.user || !credentials.pass) {
    warnings.push(
      '"tokens.smtp.user" and "tokens.smtp.pass" are both required.'
    );
  }

  // Fall back to the authenticating account so a minimal config still produces
  // a deliverable From header.
  const from = email.from || credentials.user;

  if (!from) {
    warnings.push('"email.from" is required when "tokens.smtp.user" is unset.');
  }

  if (warnings.length > 0) {
    return { enabled: false, warnings, settings: null };
  }

  const port = Number(smtp.port) || 587;

  return {
    enabled: true,
    warnings,
    settings: {
      to,
      cc,
      bcc,
      from,
      subject: email.subject || 'Repo Hero Dashboard — {range}',
      compress: email.compress === true,
      maxAttachmentMB:
        Number(email.maxAttachmentMB) > 0
          ? Number(email.maxAttachmentMB)
          : DEFAULT_MAX_ATTACHMENT_MB,
      smtp: {
        host: smtp.host,
        port,
        // Port 465 is implicit TLS; 587 and 25 negotiate STARTTLS instead.
        secure: typeof smtp.secure === 'boolean' ? smtp.secure : port === 465,
        auth: { user: credentials.user, pass: credentials.pass },
        ...(smtp.tls ? { tls: smtp.tls } : {}),
      },
    },
  };
}

// ─── Message construction ───────────────────────────────────────────────────

/**
 * Substitutes {range}, {startDate}, {endDate}, {periods} and {date} into a
 * subject template. Unknown placeholders are left untouched.
 *
 * @param {string} template subject template
 * @param {object} meta reporting metadata
 * @returns {string} rendered subject
 */
function renderSubject(template, meta) {
  const range =
    meta.startDate && meta.endDate
      ? `${meta.startDate} — ${meta.endDate}`
      : 'all time';

  const values = {
    range,
    startDate: meta.startDate || '',
    endDate: meta.endDate || '',
    periods: meta.periods != null ? String(meta.periods) : '',
    date: meta.generatedAt || new Date().toISOString().split('T')[0],
  };

  return template.replace(/\{(\w+)\}/g, (match, key) =>
    key in values ? values[key] : match
  );
}

/**
 * Builds the plain-text and HTML message bodies. The dashboard itself is the
 * payload, so the body stays a short pointer to the attachment.
 *
 * @param {object} meta reporting metadata
 * @param {string} filename attachment filename
 * @returns {{text: string, html: string}} message bodies
 */
function renderBody(meta, filename) {
  const lines = [];

  if (meta.startDate && meta.endDate) {
    lines.push(`Data range: ${meta.startDate} — ${meta.endDate}`);
  }

  if (meta.periods != null) {
    lines.push(`Periods: ${meta.periods}`);
  }

  if (meta.generatedAt) {
    lines.push(`Generated: ${meta.generatedAt}`);
  }

  const text = [
    'The latest Repo Hero dashboard is attached.',
    '',
    ...lines,
    '',
    filename.endsWith('.gz')
      ? `Decompress ${filename} and open the resulting HTML file in any browser.`
      : `Open ${filename} in any browser — it is fully self-contained and needs no server.`,
  ].join('\n');

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1f2328">
  <p>The latest <strong>Repo Hero</strong> dashboard is attached.</p>
  ${lines.length ? `<ul>${lines.map(line => `<li>${line}</li>`).join('')}</ul>` : ''}
  <p style="color:#59636e">${
    filename.endsWith('.gz')
      ? `Decompress <code>${filename}</code> and open the resulting HTML file in any browser.`
      : `Open <code>${filename}</code> in any browser — it is fully self-contained and needs no server.`
  }</p>
</div>`;

  return { text, html };
}

/**
 * Reads dashboard.html and, when compression is enabled, gzips it. The
 * dashboard inlines all of its data and assets, so it compresses by better than
 * 10x — worth it when a report is too large for a recipient's mail server.
 *
 * @param {boolean} compress whether to gzip the attachment
 * @returns {{filename: string, content: Buffer, rawSize: number}} attachment
 */
function buildAttachment(compress) {
  const raw = fs.readFileSync(dashboardFile);

  if (!compress) {
    return { filename: 'dashboard.html', content: raw, rawSize: raw.length };
  }

  return {
    filename: 'dashboard.html.gz',
    content: zlib.gzipSync(raw, { level: 9 }),
    rawSize: raw.length,
  };
}

// ─── Delivery ───────────────────────────────────────────────────────────────

/**
 * Emails the generated dashboard to the configured recipients.
 *
 * Never throws. Delivery is a convenience layered on top of the report, so a
 * misconfigured mailbox or an unreachable SMTP host reports the problem and
 * lets the pipeline finish successfully.
 *
 * @param {object} [meta] reporting metadata used for the subject and body
 * @param {string} [meta.startDate] first period start date
 * @param {string} [meta.endDate] last period end date
 * @param {number} [meta.periods] number of periods represented
 * @param {string} [meta.generatedAt] dashboard generation timestamp
 * @param {object} [config] parsed config.json; read from disk when omitted
 * @returns {Promise<{sent: boolean, reason?: string, recipients?: string[]}>} outcome
 */
async function sendDashboardEmail(meta = {}, config = loadConfig()) {
  const { enabled, warnings, settings } = resolveEmailConfig(config);

  if (!enabled) {
    if (warnings.length > 0) {
      console.warn('Email delivery is misconfigured. Skipping.');
      warnings.forEach(warning => console.warn(`  - ${warning}`));

      return { sent: false, reason: 'invalid-config' };
    }

    return { sent: false, reason: 'not-configured' };
  }

  if (!fs.existsSync(dashboardFile)) {
    console.warn(
      'dashboard.html not found. Run "npm run dashboard" first. Skipping email.'
    );

    return { sent: false, reason: 'missing-dashboard' };
  }

  const attachment = buildAttachment(settings.compress);
  const wireSize = Math.ceil(attachment.content.length * BASE64_OVERHEAD);
  const limit = settings.maxAttachmentMB * 1048576;

  if (wireSize > limit) {
    console.warn(
      `Dashboard attachment is ${formatSize(wireSize)} encoded, over the ${settings.maxAttachmentMB} MB limit. Skipping email.`
    );

    if (!settings.compress) {
      console.warn(
        '  Set "email.compress": true to attach a gzipped dashboard instead.'
      );
    }

    return { sent: false, reason: 'too-large' };
  }

  const recipients = [...settings.to, ...settings.cc, ...settings.bcc];
  const subject = renderSubject(settings.subject, meta);
  const { text, html } = renderBody(meta, attachment.filename);

  try {
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport(settings.smtp);

    await transport.sendMail({
      from: settings.from,
      to: settings.to,
      ...(settings.cc.length ? { cc: settings.cc } : {}),
      ...(settings.bcc.length ? { bcc: settings.bcc } : {}),
      subject,
      text,
      html,
      attachments: [
        {
          filename: attachment.filename,
          content: attachment.content,
          contentType: settings.compress ? 'application/gzip' : 'text/html',
        },
      ],
    });

    transport.close();

    const sizeNote = settings.compress
      ? `${formatSize(attachment.content.length)}, compressed from ${formatSize(attachment.rawSize)}`
      : formatSize(attachment.content.length);

    console.log(
      `Dashboard emailed to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'} (${sizeNote}): ${recipients.join(', ')}`
    );

    return { sent: true, recipients };
  } catch (error) {
    console.warn(`Failed to email the dashboard: ${error.message}`);

    return { sent: false, reason: 'send-failed' };
  }
}

module.exports = {
  sendDashboardEmail,
  resolveEmailConfig,
  normalizeRecipients,
  isValidAddress,
  renderSubject,
};

// ─── CLI ────────────────────────────────────────────────────────────────────
// Running this file directly emails the dashboard that is already on disk,
// without regenerating it or opening a browser.

if (require.main === module) {
  const config = loadConfig();
  const { enabled, warnings } = resolveEmailConfig(config);

  if (!enabled && warnings.length === 0) {
    console.error(
      'No "email" block found in config.json. See the README for setup.'
    );
    process.exit(1);
  }

  sendDashboardEmail(readDashboardMeta(), config).then(result => {
    if (!result.sent) process.exit(1);
  });
}

/**
 * Recovers the reporting metadata the dashboard was built from so the standalone
 * CLI produces the same subject line the pipeline would.
 *
 * @returns {object} reporting metadata, or an empty object when unavailable
 */
function readDashboardMeta() {
  const combinedFile = path.join(resultsDir, 'combined_results.json');

  try {
    const raw = JSON.parse(fs.readFileSync(combinedFile, 'utf8'));
    const keys = Object.keys(raw)
      .filter(key => key !== 'combined_results')
      .sort();

    if (keys.length === 0) return {};

    const first = raw[keys[0]]?._report_info;
    const last = raw[keys[keys.length - 1]]?._report_info;

    return {
      startDate: first?.start_date || keys[0].split('_')[0],
      endDate: last?.end_date || keys[keys.length - 1].split('_').pop(),
      periods: keys.length,
      generatedAt: fs.statSync(dashboardFile).mtime.toISOString().split('T')[0],
    };
  } catch {
    return {};
  }
}
