import { release } from 'node:os';

export function supportsSystemAudio(platform = process.platform, kernelRelease = release()) {
  if (platform === 'win32') return true;
  if (platform !== 'darwin') return false;
  const [major, minor] = String(kernelRelease).split('.').map(Number);
  // CoreAudio Tap support begins with macOS 14.2 / Darwin 23.2.
  return major > 23 || major === 23 && minor >= 2;
}

export function speechPythonPath(runtimeDir, platform = process.platform) {
  return platform === 'win32' ? `${runtimeDir}/python/python.exe` : `${runtimeDir}/python/bin/python3`;
}
