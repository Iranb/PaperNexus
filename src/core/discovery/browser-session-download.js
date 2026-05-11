import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureDir } from '../../lib/fs.js';
import { createContentSha256, normalizeDoi } from '../../lib/paper-identifiers.js';
import { unique } from '../../lib/utils.js';

const HTML_MARKERS = ['<!doctype html', '<html', '<head', '<body', '<script', '<title'];
const PDF_MIN_BYTES = 512;
const DEFAULT_BROWSER_TIMEOUT_MS = 12000;
const BROWSER_MODES = new Set([
  'browser',
  'browser-session',
  'browser_session',
  'headless-browser',
  'headless_browser',
  'institutional-browser',
  'institutional_browser'
]);

const PUBLISHER_BY_DOI_PREFIX = new Map([
  ['10.1038', 'nature'],
  ['10.1021', 'acs'],
  ['10.1126', 'science'],
  ['10.1016', 'elsevier'],
  ['10.1002', 'wiley'],
  ['10.1039', 'rsc'],
  ['10.1007', 'springer'],
  ['10.1073', 'pnas'],
  ['10.1149', 'ecs'],
  ['10.1088', 'iop'],
  ['10.1103', 'aps'],
  ['10.1146', 'annualreviews'],
  ['10.1080', 'tandfonline'],
  ['10.1063', 'aip'],
  ['10.1116', 'avs'],
  ['10.1109', 'ieee'],
  ['10.1143', 'iop'],
  ['10.1147', 'springer'],
  ['10.1364', 'osa'],
  ['10.3938', 'kps'],
  ['10.3762', 'beilstein']
]);

const PDF_SELECTORS = {
  acs: ['a[href*="/doi/pdf/"]', 'a[title*="PDF"]', 'a:has-text("Download PDF")', 'a[href*="epdf"]'],
  nature: ['a.c-pdf-download__link', 'a[data-track-action="download pdf"]', 'a[href*=".pdf"]', 'a:has-text("Download PDF")', 'a:has-text("PDF")'],
  science: ['a[href*="/doi/pdf/"]', 'a[href*="epdf"]', 'a:has-text("PDF")'],
  elsevier: ['a[href*="pdfft"]', 'a[aria-label*="View PDF"]', 'a.pdf-download-btn-link', 'a:has-text("Download PDF")', 'a:has-text("View PDF")', 'a:has-text("PDF")'],
  wiley: ['a[href*="pdfdirect"]', 'a[href*="/doi/pdf/"]', 'a[href*="/doi/epdf/"]', 'a.pdf-download', 'a:has-text("Download PDF")', 'a:has-text("PDF")'],
  rsc: ['a[href*="articlepdf"]', 'a.btn--pdf', 'a:has-text("Article PDF")'],
  springer: ['a[data-track-action*="pdf"]', 'a[href*="content/pdf"]', 'a:has-text("Download PDF")'],
  pnas: ['a[href*="/doi/pdf/"]', 'a:has-text("PDF")'],
  ecs: ['a[href$="/pdf"]', 'a[href*="/article/"][href*="/pdf"]', 'a:has-text("Full Text PDF")', 'a:has-text("Download article PDF")', 'a:has-text("PDF")'],
  iop: ['a[href$="/pdf"]', 'a[href*="/article/"][href*="/pdf"]', 'a:has-text("Full Text PDF")', 'a:has-text("Download article PDF")', 'a:has-text("PDF")'],
  aip: ['a[href*="/pdf/"]', 'a[data-article-url*="pdf"]', 'a:has-text("PDF")', 'a:has-text("Download PDF")', 'button:has-text("PDF")', 'a[href*=".pdf"]'],
  avs: ['a[href*="/pdf/"]', 'a:has-text("PDF")', 'a:has-text("Download PDF")', 'button:has-text("PDF")'],
  ieee: ['a[href*="/stamp/"]', 'a.stats-document-lh-action-downloads-PDF', 'a:has-text("PDF")', 'button:has-text("PDF")'],
  aps: ['a[href*="/pdf/"]', 'a:has-text("PDF")', 'a:has-text("Download PDF")'],
  annualreviews: ['a[href*="/doi/pdf/"]', 'a:has-text("PDF")', 'a:has-text("Download PDF")'],
  tandfonline: ['a[href*="/doi/pdf/"]', 'a[href*="download?"]', 'a:has-text("PDF")', 'a:has-text("Download PDF")'],
  osa: ['a[href*="viewmedia"]', 'a[href*="/pdf"]', 'a:has-text("PDF")', 'a:has-text("Download PDF")'],
  kps: ['a[href*=".pdf"]', 'a:has-text("PDF")'],
  beilstein: ['a[href*="/downloads/pdf/"]', 'a[href*=".pdf"]', 'a:has-text("PDF")', 'a:has-text("Download PDF")']
};

const GENERIC_PDF_SELECTORS = ['a[href*=".pdf"]', 'a[href*="/pdf"]', 'a:has-text("PDF")', 'button:has-text("PDF")'];
const PDF_URL_TOKENS = ['/doi/pdf/', '/doi/epdf/', 'pdfdirect', 'pdfft', '/content/pdf/', '/stamp/stamp.jsp', '/pdf/', 'main.pdf'];
const CAPTCHA_SELECTOR = [
  '#px-captcha',
  'div.cf-turnstile',
  '#cf-challenge-running',
  '.cf-browser-verification',
  '#challenge-form',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="recaptcha"]'
].join(',');

function splitList(value = '') {
  if (Array.isArray(value)) return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  return String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isHttpUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function browserMode(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function shouldUseBrowserSessionDownloads(params = {}) {
  return BROWSER_MODES.has(browserMode(
    params.institutionalAccessMode
    || params.institutional_access_mode
    || process.env.PAPERNEXUS_INSTITUTIONAL_ACCESS_MODE
  ));
}

function publisherForCandidate(candidate = {}) {
  const explicit = String(candidate.publisher || candidate.publisherKey || candidate.publisher_key || '').trim().toLowerCase();
  if (explicit && PDF_SELECTORS[explicit]) return explicit;
  const doi = normalizeDoi(candidate.identifiers?.doi || candidate.doi);
  const prefix = doi.split('/')[0];
  return PUBLISHER_BY_DOI_PREFIX.get(prefix) || '';
}

function doiForUrl(candidate = {}) {
  return String(candidate.identifiers?.doi || candidate.doi || '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/\s+/g, '');
}

function ieeeArticleNumberForCandidate(candidate = {}) {
  const explicit = [
    candidate.articleNumber,
    candidate.article_number,
    candidate.arNumber,
    candidate.arnumber,
    candidate.identifiers?.articleNumber,
    candidate.identifiers?.article_number,
    candidate.identifiers?.arNumber,
    candidate.identifiers?.arnumber
  ].map((entry) => String(entry || '').trim()).find(Boolean);
  if (explicit && /^\d+$/.test(explicit)) return explicit;

  const urls = [
    candidate.landingPageUrl,
    candidate.pdfUrl,
    candidate.source?.pdfUrl,
    ...(candidate.sourceHints || []),
    ...(candidate.fullTextUrls || [])
  ].filter(Boolean);
  for (const url of urls) {
    const match = String(url).match(/(?:\/document\/|[?&]arnumber=)(\d+)/i);
    if (match) return match[1];
  }
  return '';
}

function natureSlug(doi = '') {
  return doi.split('/').slice(1).join('/').replace(/\./g, '');
}

function directPublisherPdfUrls(doi = '', publisher = '', candidate = {}) {
  if (!doi) return [];
  const ieeeArticleNumber = ieeeArticleNumberForCandidate(candidate);
  const urls = {
    acs: `https://pubs.acs.org/doi/pdf/${doi}`,
    nature: `https://www.nature.com/articles/${natureSlug(doi)}.pdf`,
    science: `https://www.science.org/doi/pdf/${doi}`,
    wiley: `https://onlinelibrary.wiley.com/doi/pdfdirect/${doi}`,
    pnas: `https://www.pnas.org/doi/pdf/${doi}`,
    springer: `https://link.springer.com/content/pdf/${doi}.pdf`,
    ecs: `https://iopscience.iop.org/article/${doi}/pdf`,
    iop: `https://iopscience.iop.org/article/${doi}/pdf`,
    ieee: ieeeArticleNumber ? `https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=${ieeeArticleNumber}` : ''
  };
  return urls[publisher] ? [urls[publisher]] : [];
}

function publisherArticleUrls(doi = '', publisher = '', candidate = {}) {
  if (!doi) return [];
  const ieeeArticleNumber = ieeeArticleNumberForCandidate(candidate);
  const urls = {
    nature: `https://www.nature.com/articles/${natureSlug(doi)}`,
    acs: `https://pubs.acs.org/doi/${doi}`,
    science: `https://www.science.org/doi/${doi}`,
    springer: `https://link.springer.com/article/${doi}`,
    pnas: `https://www.pnas.org/doi/${doi}`,
    ecs: `https://iopscience.iop.org/article/${doi}`,
    iop: `https://iopscience.iop.org/article/${doi}`,
    annualreviews: `https://www.annualreviews.org/content/journals/${doi}`,
    ieee: ieeeArticleNumber ? `https://ieeexplore.ieee.org/document/${ieeeArticleNumber}` : ''
  };
  return unique([urls[publisher], `https://doi.org/${doi}`].filter(Boolean));
}

export function collectBrowserSessionCandidateUrls(candidate = {}) {
  const doi = doiForUrl(candidate) || normalizeDoi(candidate.identifiers?.doi || candidate.doi);
  const publisher = publisherForCandidate(candidate);
  return unique([
    candidate.source?.pdfUrl,
    candidate.pdfUrl,
    ...(candidate.sourceHints || []),
    ...(candidate.fullTextUrls || []),
    ...directPublisherPdfUrls(doi, publisher, candidate),
    candidate.landingPageUrl,
    candidate.bestOaUrl,
    ...publisherArticleUrls(doi, publisher, candidate)
  ].filter((url) => isHttpUrl(url)));
}

function resolveBrowserChannel(options = {}) {
  return String(options.browserChannel || options.browser_channel || process.env.PAPERNEXUS_BROWSER_CHANNEL || 'msedge').trim();
}

function expandHome(value = '') {
  return String(value || '').trim().replace(/^~(?=$|\/|\\)/, os.homedir());
}

function resolveBrowserExecutablePath(options = {}) {
  return expandHome(options.browserExecutablePath || options.browser_executable_path || process.env.PAPERNEXUS_BROWSER_EXECUTABLE_PATH || '');
}

function resolveBrowserProfileName(options = {}) {
  return String(options.browserProfileName || options.browser_profile_name || process.env.PAPERNEXUS_BROWSER_PROFILE_NAME || 'Default').trim();
}

function resolveBrowserLaunchArgs(options = {}) {
  const args = ['--disable-blink-features=AutomationControlled'];
  const profileName = resolveBrowserProfileName(options);
  if (profileName && profileName !== 'Default') {
    args.unshift(`--profile-directory=${profileName}`);
  }
  return args;
}

function resolveBrowserProfileDir(options = {}) {
  const configured = String(options.browserProfileDir || options.browser_profile_dir || process.env.PAPERNEXUS_BROWSER_PROFILE_DIR || '').trim();
  if (configured) return expandHome(configured);
  const channel = resolveBrowserChannel(options).toLowerCase();
  const home = os.homedir();

  if (channel.includes('edge')) {
    if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Microsoft', 'Edge', 'User Data');
    if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Microsoft Edge');
    return path.join(home, '.config', 'microsoft-edge');
  }
  if (channel.includes('chrome')) {
    if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
    if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    return path.join(home, '.config', 'google-chrome');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Chromium');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Chromium', 'User Data');
  return path.join(home, '.config', 'chromium');
}

function resolveBrowserTimeoutMs(options = {}) {
  const parsed = Number(options.browserDownloadTimeoutMs || options.browser_download_timeout_ms || process.env.PAPERNEXUS_BROWSER_DOWNLOAD_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_BROWSER_TIMEOUT_MS;
}

function resolveBrowserHeadless(options = {}) {
  const raw = options.browserHeadless ?? options.browser_headless ?? process.env.PAPERNEXUS_BROWSER_HEADLESS;
  if (raw === undefined || raw === null || raw === '') return true;
  if (raw === false) return false;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

function accessPatterns(options = {}) {
  return {
    authHosts: splitList(options.browserAuthHosts || options.browser_auth_hosts || process.env.PAPERNEXUS_BROWSER_AUTH_HOSTS),
    authUrlFragments: splitList(options.browserAuthUrlFragments || options.browser_auth_url_fragments || process.env.PAPERNEXUS_BROWSER_AUTH_URL_FRAGMENTS),
    authPageTitles: splitList(options.browserAuthPageTitles || options.browser_auth_page_titles || process.env.PAPERNEXUS_BROWSER_AUTH_PAGE_TITLES)
  };
}

function validatePdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PDF_MIN_BYTES) return { valid: false, reason: 'too-small' };
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return { valid: true, reason: 'pdf-header-ok' };
  const preview = buffer.subarray(0, 4096).toString('utf8').toLowerCase();
  if (HTML_MARKERS.some((marker) => preview.includes(marker))) return { valid: false, reason: 'html_not_pdf' };
  return { valid: false, reason: 'missing-pdf-header' };
}

function looksLikePdfUrl(value = '') {
  const normalized = String(value || '').toLowerCase();
  return normalized.endsWith('.pdf') || PDF_URL_TOKENS.some((token) => normalized.includes(token));
}

function titleFromHtml(html = '') {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return compactText(match?.[1] || '');
}

function inspectAccessBarrier({ url = '', title = '', text = '' } = {}, options = {}) {
  const lowerUrl = String(url || '').toLowerCase();
  const lowerTitle = String(title || '').toLowerCase();
  const lowerText = String(text || '').toLowerCase();
  const patterns = accessPatterns(options);

  if (patterns.authHosts.some((host) => lowerUrl.includes(String(host).toLowerCase()))
    || patterns.authUrlFragments.some((fragment) => lowerUrl.includes(String(fragment).toLowerCase()))
    || patterns.authPageTitles.some((fragment) => lowerTitle.includes(String(fragment).toLowerCase()))) {
    return { kind: 'sso', reason: 'institution_auth_redirect', url, title };
  }
  if (/(saml|shibboleth|openid|oauth|ezproxy|idp|single sign-?on)/i.test(`${url} ${title} ${text}`)) {
    return { kind: 'sso', reason: 'institution_auth_redirect', url, title };
  }
  if (/(captcha|hcaptcha|recaptcha|cf-turnstile|verify you are human|cloudflare|security check|just a moment|attention required|please wait|checking your browser|请稍候|稍候)/i.test(`${title} ${text}`)) {
    return { kind: 'captcha', reason: 'captcha_or_challenge', url, title };
  }
  if (/(access denied|request rejected|forbidden|please enable cookies|please enable javascript)/i.test(`${title} ${text}`)) {
    return { kind: 'access_denied', reason: 'access_control_blocked', url, title };
  }
  return null;
}

async function inspectPageAccessBarrier(page, options = {}) {
  try {
    const snapshot = await page.evaluate((captchaSelector) => ({
      title: document.title || '',
      text: (document.body?.innerText || '').slice(0, 5000),
      captchaDetected: Boolean(document.querySelector(captchaSelector))
    }), CAPTCHA_SELECTOR);
    if (snapshot?.captchaDetected) {
      return { kind: 'captcha', reason: 'captcha_or_challenge', url: page.url(), title: snapshot?.title || '' };
    }
    return inspectAccessBarrier({
      url: page.url(),
      title: snapshot?.title || '',
      text: snapshot?.text || ''
    }, options);
  } catch {
    return inspectAccessBarrier({ url: page.url() }, options);
  }
}

async function writePdf(outputPath, buffer) {
  const validation = validatePdfBuffer(buffer);
  if (!validation.valid) return { ok: false, reason: validation.reason };
  await ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, buffer);
  return {
    ok: true,
    reason: validation.reason,
    contentSha256: createContentSha256(buffer)
  };
}

function failed(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

function isRetriableBrowserLaunchError(error) {
  const message = compactText(error?.message || error);
  return /Browser\.getWindowForTarget|browser window not found/i.test(message);
}

async function launchBrowserSessionContext(chromium, profileDir, options = {}) {
  const executablePath = resolveBrowserExecutablePath(options);
  const launchOptions = {
    headless: resolveBrowserHeadless(options),
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    args: resolveBrowserLaunchArgs(options)
  };
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  } else {
    launchOptions.channel = resolveBrowserChannel(options);
  }
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await chromium.launchPersistentContext(profileDir, launchOptions);
    } catch (error) {
      lastError = error;
      if (attempt >= 2 || !isRetriableBrowserLaunchError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw lastError;
}

async function tryBrowserRequest(context, url, outputPath, options = {}) {
  try {
    const response = await context.request.get(url, {
      timeout: resolveBrowserTimeoutMs(options),
      maxRedirects: 5,
      headers: {
        accept: 'application/pdf,text/html;q=0.4,*/*;q=0.2'
      }
    });
    const contentType = String(response.headers()['content-type'] || '');
    const body = Buffer.from(await response.body());
    if (response.ok() && (contentType.toLowerCase().includes('pdf') || looksLikePdfUrl(url))) {
      const saved = await writePdf(outputPath, body);
      if (saved.ok) return { ...saved, url, strategy: 'browser_context_request' };
    }
    const preview = body.subarray(0, 8000).toString('utf8');
    const barrier = inspectAccessBarrier({
      url: response.url(),
      title: titleFromHtml(preview),
      text: preview
    }, options);
    if (barrier) return failed(barrier.reason, { url: response.url(), accessBarrier: barrier, manual: true, strategy: 'browser_context_request' });
    return failed(response.ok() ? 'not_pdf' : `http-${response.status()}`, { url: response.url(), strategy: 'browser_context_request' });
  } catch (error) {
    return failed(`browser-request-failed: ${compactText(error?.message || error)}`, { url, strategy: 'browser_context_request' });
  }
}

async function fetchPdfInPage(page, url, outputPath, options = {}) {
  try {
    const payload = await page.evaluate(async (targetUrl) => {
      const response = await fetch(targetUrl, { credentials: 'include' });
      const contentType = response.headers.get('content-type') || '';
      const buffer = await response.arrayBuffer();
      if (!response.ok || buffer.byteLength < 512) {
        return { ok: false, status: response.status, contentType, text: new TextDecoder().decode(buffer.slice(0, 8000)) };
      }
      const bytes = Array.from(new Uint8Array(buffer));
      return { ok: true, status: response.status, contentType, bytes };
    }, url);
    if (payload?.ok && String(payload.contentType || '').toLowerCase().includes('pdf')) {
      const saved = await writePdf(outputPath, Buffer.from(payload.bytes));
      if (saved.ok) return { ...saved, url, strategy: 'page_fetch_with_credentials' };
    }
    const barrier = inspectAccessBarrier({
      url,
      title: '',
      text: payload?.text || ''
    }, options);
    if (barrier) return failed(barrier.reason, { url, accessBarrier: barrier, manual: true, strategy: 'page_fetch_with_credentials' });
    return failed(payload?.ok ? 'not_pdf' : `http-${payload?.status || 'unknown'}`, { url, strategy: 'page_fetch_with_credentials' });
  } catch (error) {
    return failed(`page-fetch-failed: ${compactText(error?.message || error)}`, { url, strategy: 'page_fetch_with_credentials' });
  }
}

async function collectPdfLinks(page, publisher = '') {
  const selectors = [...(PDF_SELECTORS[publisher] || []), ...GENERIC_PDF_SELECTORS];
  const selectorLinks = [];
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector);
      const count = Math.min(await locator.count(), 6);
      for (let index = 0; index < count; index += 1) {
        const href = await locator.nth(index).getAttribute('href');
        if (href) selectorLinks.push(new URL(href, page.url()).toString());
      }
    } catch {}
  }
  let scoredLinks = [];
  try {
    scoredLinks = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((anchor) => ({
      href: anchor.href || '',
      text: (anchor.textContent || '').trim()
    })));
  } catch {}
  const scored = scoredLinks
    .filter((entry) => entry?.href && (
      looksLikePdfUrl(entry.href)
      || /\b(download|view)?\s*pdf\b/i.test(entry.text || '')
    ))
    .map((entry) => entry.href);
  let embeddedLinks = [];
  try {
    const html = await page.content();
    embeddedLinks = [
      ...Array.from(html.matchAll(/pdfPath\\?["']\s*:\s*\\?["']([^"'\\]+\.pdf[^"'\\]*)/gi), (match) => match[1]),
      ...Array.from(html.matchAll(/stamp\.jsp\?[^"'<>\\\s]+/gi), (match) => match[0])
    ].map((href) => new URL(href.replace(/\\\//g, '/'), page.url()).toString());
  } catch {}
  return unique([...selectorLinks, ...scored, ...embeddedLinks].filter((url) => isHttpUrl(url)));
}

async function tryPdfClick(page, context, publisher, outputPath, options = {}) {
  const selectors = [...(PDF_SELECTORS[publisher] || []), ...GENERIC_PDF_SELECTORS];
  for (const selector of selectors) {
    let locator;
    try {
      locator = page.locator(selector).first();
      if (await locator.count() === 0 || !(await locator.isVisible())) continue;
    } catch {
      continue;
    }

    let download = null;
    let popup = null;
    try {
      const downloadPromise = page.waitForEvent('download', { timeout: 3000 }).catch(() => null);
      const popupPromise = context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
      await locator.click({ timeout: 3000 });
      [download, popup] = await Promise.all([downloadPromise, popupPromise]);
    } catch {
      continue;
    }

    if (download) {
      const tempPath = await download.path();
      if (tempPath) {
        const buffer = await fs.readFile(tempPath);
        const saved = await writePdf(outputPath, buffer);
        if (saved.ok) return { ...saved, url: page.url(), strategy: 'browser_download_event' };
      }
    }
    if (popup) {
      try {
        await popup.waitForLoadState('domcontentloaded', { timeout: resolveBrowserTimeoutMs(options) });
      } catch {}
      const barrier = await inspectPageAccessBarrier(popup, options);
      if (barrier) return failed(barrier.reason, { url: popup.url(), accessBarrier: barrier, manual: true, strategy: 'browser_popup_click' });
      const links = await collectPdfLinks(popup, publisher);
      let firstManualOutcome = null;
      for (const href of links) {
        const requestOutcome = await tryBrowserRequest(context, href, outputPath, options);
        if (requestOutcome.ok) return requestOutcome;
        if (requestOutcome.accessBarrier && !firstManualOutcome) firstManualOutcome = requestOutcome;
      }
      if (looksLikePdfUrl(popup.url())) {
        const pageOutcome = await fetchPdfInPage(popup, popup.url(), outputPath, options);
        if (pageOutcome.ok) return pageOutcome;
        if (pageOutcome.accessBarrier && !firstManualOutcome) firstManualOutcome = pageOutcome;
      }
      if (firstManualOutcome) return firstManualOutcome;
    }
  }
  return failed('no_pdf_click_captured', { strategy: 'browser_selector_click' });
}

async function tryArticlePage(context, articleUrl, publisher, outputPath, options = {}) {
  const page = await context.newPage();
  try {
    await page.goto(articleUrl, {
      waitUntil: 'domcontentloaded',
      timeout: resolveBrowserTimeoutMs(options)
    }).catch(() => null);
    await page.waitForTimeout(300).catch(() => null);
    const barrier = await inspectPageAccessBarrier(page, options);
    if (barrier) return failed(barrier.reason, { url: page.url(), accessBarrier: barrier, manual: true, strategy: 'browser_article_page' });
    const links = await collectPdfLinks(page, publisher);
    let firstManualOutcome = null;
    for (const href of links) {
      const requestOutcome = await tryBrowserRequest(context, href, outputPath, options);
      if (requestOutcome.ok) return requestOutcome;
      if (requestOutcome.accessBarrier && !firstManualOutcome) firstManualOutcome = requestOutcome;
      const pageOutcome = await fetchPdfInPage(page, href, outputPath, options);
      if (pageOutcome.ok) return pageOutcome;
      if (pageOutcome.accessBarrier && !firstManualOutcome) firstManualOutcome = pageOutcome;
    }
    const clickOutcome = await tryPdfClick(page, context, publisher, outputPath, options);
    if (clickOutcome.ok) return clickOutcome;
    if (clickOutcome.accessBarrier && !firstManualOutcome) firstManualOutcome = clickOutcome;
    if (firstManualOutcome) return firstManualOutcome;
    return failed('no_pdf_found_on_article_page', { url: page.url(), strategy: 'browser_article_page' });
  } finally {
    await page.close().catch(() => {});
  }
}

async function loadPlaywright() {
  try {
    const mod = await import('playwright');
    return mod.chromium;
  } catch (error) {
    try {
      const mod = await import('playwright-core');
      return mod.chromium;
    } catch (fallbackError) {
      return { error: fallbackError, primaryError: error };
    }
  }
}

export async function downloadPdfWithBrowserSession(candidate = {}, outputPath, options = {}) {
  const chromium = await loadPlaywright();
  if (chromium.error) {
    return failed('playwright-unavailable', {
      detail: compactText(chromium.error?.message || chromium.error),
      provider: 'browser_session'
    });
  }

  const doi = doiForUrl(candidate) || normalizeDoi(candidate.identifiers?.doi || candidate.doi);
  const publisher = publisherForCandidate(candidate);
  const urls = collectBrowserSessionCandidateUrls(candidate);
  if (!urls.length) return failed('missing-browser-download-url', { provider: 'browser_session' });

  const directUrls = unique([
    ...directPublisherPdfUrls(doi, publisher, candidate),
    ...urls.filter((url) => looksLikePdfUrl(url))
  ]);
  const articleUrls = unique([
    ...urls.filter((url) => !looksLikePdfUrl(url)),
    ...publisherArticleUrls(doi, publisher, candidate)
  ]);

  let context;
  const attempts = [];
  let firstManualOutcome = null;
  const profileDir = resolveBrowserProfileDir(options);
  try {
    context = await launchBrowserSessionContext(chromium, profileDir, options);

    for (const url of directUrls) {
      const outcome = await tryBrowserRequest(context, url, outputPath, options);
      attempts.push({ url, status: outcome.ok ? 'success' : (outcome.manual ? 'manual_pending' : 'failed'), reason: outcome.reason, strategy: outcome.strategy, accessBarrier: outcome.accessBarrier || null });
      if (outcome.ok) return { ...outcome, attempts, provider: 'browser_session' };
      if (outcome.accessBarrier && !firstManualOutcome) firstManualOutcome = outcome;
    }

    for (const url of articleUrls) {
      const outcome = await tryArticlePage(context, url, publisher, outputPath, options);
      attempts.push({ url, status: outcome.ok ? 'success' : (outcome.manual ? 'manual_pending' : 'failed'), reason: outcome.reason, strategy: outcome.strategy, accessBarrier: outcome.accessBarrier || null });
      if (outcome.ok) return { ...outcome, attempts, provider: 'browser_session' };
      if (outcome.accessBarrier && !firstManualOutcome) firstManualOutcome = outcome;
    }

    if (firstManualOutcome) return { ...firstManualOutcome, attempts, provider: 'browser_session' };
    return failed(attempts.at(-1)?.reason || 'browser-session-download-failed', {
      attempts,
      provider: 'browser_session'
    });
  } catch (error) {
    return failed(`browser-session-failed: ${compactText(error?.message || error)}`, {
      attempts,
      provider: 'browser_session',
      profileDir
    });
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
