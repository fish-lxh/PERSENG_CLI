import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = __dirname;
const ENV_FILES = ['.env', '.evn'];
let loadedEnvInfo = {
  path: null,
  parsed: {},
  appliedKeys: [],
};

function parseEnvContent(content) {
  const parsed = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

export function getProjectRoot() {
  return PROJECT_ROOT;
}

export function getProjectEnvCandidates() {
  return ENV_FILES.map((name) => resolve(PROJECT_ROOT, name));
}

export function getLoadedProjectEnvInfo() {
  return {
    path: loadedEnvInfo.path,
    parsed: { ...loadedEnvInfo.parsed },
    appliedKeys: [...loadedEnvInfo.appliedKeys],
  };
}

export function loadProjectEnv() {
  for (const envPath of getProjectEnvCandidates()) {
    if (!existsSync(envPath)) continue;

    try {
      const parsed = parseEnvContent(readFileSync(envPath, 'utf-8'));
      const appliedKeys = [];
      for (const [key, value] of Object.entries(parsed)) {
        if (!process.env[key]) {
          process.env[key] = value;
          appliedKeys.push(key);
        }
      }
      loadedEnvInfo = {
        path: envPath,
        parsed,
        appliedKeys,
      };
      return envPath;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[perseng] Warning: failed to load ${envPath}: ${message}\n`);
    }
  }

  loadedEnvInfo = {
    path: null,
    parsed: {},
    appliedKeys: [],
  };
  return null;
}
