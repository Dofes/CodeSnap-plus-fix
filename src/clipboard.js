'use strict';

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Puts the PNG on the clipboard as is (keeps transparency) plus a bitmap for apps that only
// read bitmaps. The path arrives through the environment, so it needs no quoting.
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
  '$bytes = [IO.File]::ReadAllBytes($env:CODESNAP_IMAGE)',
  '$data = New-Object Windows.Forms.DataObject',
  "$data.SetData('PNG', $false, (New-Object IO.MemoryStream(, $bytes)))",
  '$data.SetImage([Drawing.Image]::FromStream((New-Object IO.MemoryStream(, $bytes))))',
  '[Windows.Forms.Clipboard]::SetDataObject($data, $true)'
].join('; ');

const commandFor = (file) => {
  switch (process.platform) {
    case 'win32':
      return [
        path.join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe'
        ),
        ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_SCRIPT],
        { CODESNAP_IMAGE: file }
      ];
    case 'darwin':
      return [
        'osascript',
        [
          '-e',
          'on run argv',
          '-e',
          'set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)',
          '-e',
          'end run',
          file
        ]
      ];
    default:
      return process.env.WAYLAND_DISPLAY
        ? ['sh', ['-c', 'wl-copy --type image/png < "$0"', file]]
        : ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i', file]];
  }
};

// Resolves on 'exit' rather than 'close': xclip and wl-copy leave a child behind that keeps
// serving the clipboard and holds on to inherited pipes.
const run = (command, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    child.on('error', reject);
    child.on('exit', (code) => {
      child.stderr.destroy();
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with ${code}`));
    });
  });

/** Writes a PNG to the system clipboard with the platform's own tools. */
const copyPngWithSystemTools = async (png) => {
  const file = path.join(os.tmpdir(), `codesnap-${process.pid}-${Date.now()}.png`);
  await fs.writeFile(file, png);
  const [command, args, env] = commandFor(file);
  try {
    await run(command, args, env);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    throw new Error(`${command} is needed to copy images this large, use Save instead.`);
  } finally {
    // Every tool has read the file by the time it exits.
    await fs.unlink(file).catch(() => undefined);
  }
};

module.exports = { copyPngWithSystemTools };
