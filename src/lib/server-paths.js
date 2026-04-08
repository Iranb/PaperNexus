import os from 'node:os';
import path from 'node:path';

function getPortableHomeDir(options = {}) {
  const configured = String(options.homeDir || '').trim();
  if (configured) return configured;
  const envHome = String(process.env.PAPERNEXUS_SERVER_HOME || process.env.HOME || '').trim();
  if (envHome) return envHome;
  return os.homedir();
}

export function isHomeRelativePath(value) {
  const raw = String(value || '').trim();
  return raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\');
}

export function isServerPathReference(value) {
  const raw = String(value || '').trim();
  return Boolean(raw) && (isHomeRelativePath(raw) || path.isAbsolute(raw));
}

export function resolveServerPathReference(value, options = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const homeDir = getPortableHomeDir(options);
  const baseDir = options.baseDir || homeDir;
  if (raw === '~') return homeDir;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(homeDir, raw.slice(2));
  }
  return path.resolve(baseDir, raw);
}

export function collapseHomePath(value, options = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!isServerPathReference(raw)) return raw;

  const homeDir = path.resolve(getPortableHomeDir(options));
  const resolved = path.resolve(resolveServerPathReference(raw, {
    homeDir,
    baseDir: homeDir
  }));

  if (resolved === homeDir) return '~';

  const relative = path.relative(homeDir, resolved);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join('/')}`;
  }

  return resolved;
}
