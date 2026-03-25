import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ensureDir, fileExists, removePath, writeText } from './fs.js';

const execFileAsync = promisify(execFile);
const SERVICE_LABELS = {
  watch: 'com.papernexus.watch',
  serve: 'com.papernexus.serve'
};

function ensureMacOsLaunchd() {
  if (process.platform !== 'darwin') {
    throw new Error('PaperNexus background service registration is currently supported only on macOS.');
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function getSupportedLaunchdServices() {
  return ['watch', 'serve'];
}

export function normalizeLaunchdServices(value) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  const services = rawValues.length ? rawValues : ['watch', 'serve'];
  const normalized = [...new Set(services.map((service) => String(service || '').trim().toLowerCase()).filter(Boolean))];

  for (const service of normalized) {
    if (!SERVICE_LABELS[service]) {
      throw new Error(`Unsupported service "${service}". Supported values: ${getSupportedLaunchdServices().join(', ')}`);
    }
  }

  return normalized;
}

export function getLaunchAgentDir(homeDir = os.homedir()) {
  return path.join(homeDir, 'Library', 'LaunchAgents');
}

export function getLaunchAgentPath(service, homeDir = os.homedir()) {
  return path.join(getLaunchAgentDir(homeDir), `${SERVICE_LABELS[service]}.plist`);
}

function getLaunchctlDomainTarget() {
  if (typeof process.getuid !== 'function') {
    throw new Error('Could not determine the current macOS user id for launchd.');
  }

  return `gui/${process.getuid()}`;
}

async function runLaunchctl(args, options = {}) {
  ensureMacOsLaunchd();

  try {
    return await (options.runner || execFileAsync)('launchctl', args);
  } catch (error) {
    if (options.allowFailure) {
      return null;
    }
    throw error;
  }
}

function buildProgramArguments(service, options = {}) {
  const args = [options.nodePath, options.cliPath, service];
  if (options.configPath) {
    args.push('--config', options.configPath);
  }
  return args;
}

export function buildLaunchAgentPlist(service, options = {}) {
  const label = SERVICE_LABELS[service];
  if (!label) {
    throw new Error(`Unsupported service "${service}".`);
  }

  const programArguments = buildProgramArguments(service, options)
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(options.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(options.stderrPath)}</string>
</dict>
</plist>
`;
}

export async function installLaunchdService(service, options = {}) {
  ensureMacOsLaunchd();

  const launchAgentPath = getLaunchAgentPath(service, options.homeDir);
  const launchAgentDir = path.dirname(launchAgentPath);
  const plist = buildLaunchAgentPlist(service, options);
  const domainTarget = getLaunchctlDomainTarget();

  await ensureDir(launchAgentDir);
  await ensureDir(path.dirname(options.stdoutPath));
  await writeText(launchAgentPath, plist);

  await runLaunchctl(['bootout', domainTarget, launchAgentPath], {
    runner: options.runner,
    allowFailure: true
  });
  await runLaunchctl(['bootstrap', domainTarget, launchAgentPath], {
    runner: options.runner
  });

  return {
    service,
    label: SERVICE_LABELS[service],
    launchAgentPath
  };
}

export async function uninstallLaunchdService(service, options = {}) {
  ensureMacOsLaunchd();

  const launchAgentPath = getLaunchAgentPath(service, options.homeDir);
  const domainTarget = getLaunchctlDomainTarget();

  await runLaunchctl(['bootout', domainTarget, launchAgentPath], {
    runner: options.runner,
    allowFailure: true
  });
  await removePath(launchAgentPath);

  return {
    service,
    label: SERVICE_LABELS[service],
    launchAgentPath
  };
}

export async function getLaunchdServiceStatus(service, options = {}) {
  ensureMacOsLaunchd();

  const launchAgentPath = getLaunchAgentPath(service, options.homeDir);
  const label = SERVICE_LABELS[service];
  const domainTarget = getLaunchctlDomainTarget();
  const installed = await fileExists(launchAgentPath);
  let loaded = false;

  try {
    await runLaunchctl(['print', `${domainTarget}/${label}`], {
      runner: options.runner
    });
    loaded = true;
  } catch {
    loaded = false;
  }

  return {
    service,
    label,
    installed,
    loaded,
    launchAgentPath
  };
}
