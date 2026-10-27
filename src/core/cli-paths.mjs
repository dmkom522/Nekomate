import path from 'node:path';

function envValue(env, name) {
  const key = Object.keys(env).find(key => key.toUpperCase() === name.toUpperCase());
  return key ? env[key] : '';
}

export function normalizeCliPath(value = '', env = process.env, platform = process.platform) {
  let file = String(value).trim();
  if ((file.startsWith('"') && file.endsWith('"')) || (file.startsWith("'") && file.endsWith("'"))) file = file.slice(1, -1);
  const home = envValue(env, platform === 'win32' ? 'USERPROFILE' : 'HOME');
  if (/^~[\\/]/.test(file) && home) file = path.join(home, file.slice(2));
  if (platform === 'win32') file = file.replace(/%([^%]+)%/g, (match, key) => envValue(env, key) || match);
  return file;
}

export function cliSearchPaths(kind, env = process.env, platform = process.platform) {
  const delimiter = platform === 'win32' ? ';' : ':';
  const dirs = (envValue(env, 'PATH') || '').split(delimiter).map(value => normalizeCliPath(value, env, platform)).filter(Boolean);
  const home = envValue(env, platform === 'win32' ? 'USERPROFILE' : 'HOME');
  const add = (root, ...parts) => { if (root) dirs.push(path.join(root, ...parts)); };
  if (kind === 'codex') {
    add(envValue(env, 'CODEX_INSTALL_DIR'));
    if (platform === 'win32') add(envValue(env, 'LOCALAPPDATA'), 'Programs', 'OpenAI', 'Codex', 'bin');
    if (platform === 'darwin') {
      for (const root of ['/Applications', home && path.join(home, 'Applications')].filter(Boolean)) {
        add(root, 'Codex.app', 'Contents', 'Resources');
        add(root, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS');
      }
    }
  }
  add(home, '.local', 'bin'); add(home, '.bun', 'bin'); add(home, '.cargo', 'bin');
  add(envValue(env, 'UV_TOOL_BIN_DIR'));
  add(envValue(env, 'NVM_SYMLINK')); add(envValue(env, 'NVM_BIN'));
  add(envValue(env, 'VOLTA_HOME'), 'bin'); add(home, '.volta', 'bin');
  if (platform === 'win32') {
    add(envValue(env, 'APPDATA'), 'npm');
    add(envValue(env, 'LOCALAPPDATA'), 'Programs', 'nodejs');
    add(envValue(env, 'ProgramFiles'), 'nodejs');
    add(envValue(env, 'LOCALAPPDATA'), 'Microsoft', 'WinGet', 'Links');
  } else dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin');
  const seen = new Set();
  return dirs.filter(dir => {
    const key = platform === 'win32' ? dir.toLowerCase() : dir;
    if (seen.has(key)) return false; seen.add(key); return true;
  });
}

export function withSearchPath(env, dirs) {
  const result = { ...env };
  for (const key of Object.keys(result)) if (key.toUpperCase() === 'PATH') delete result[key];
  result.PATH = dirs.join(path.delimiter);
  return result;
}
