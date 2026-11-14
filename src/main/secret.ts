import { spawnSync } from 'node:child_process';

// Encrypts the AniList token with Windows DPAPI (tied to your Windows account) via PowerShell,
// so it is never stored in plain text and no native module is needed.
function dpapi(op: 'Protect' | 'Unprotect', input: string): string {
  const script =
    op === 'Protect'
      ? "Add-Type -AssemblyName System.Security; $i=[Console]::In.ReadToEnd(); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($i),$null,'CurrentUser'))"
      : "Add-Type -AssemblyName System.Security; $i=[Console]::In.ReadToEnd().Trim(); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($i),$null,'CurrentUser'))";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error('Could not ' + op.toLowerCase() + ' the saved token.');
  return r.stdout.trim();
}

export const protect = (plain: string) => dpapi('Protect', plain);
export const unprotect = (b64: string) => dpapi('Unprotect', b64);
