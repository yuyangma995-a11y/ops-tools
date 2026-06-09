const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const http = require('http');
const https = require('https');
const os = require('os');

const BUILD = 'ops-workbench-auth-2026-06-08';
const INSTALLER_VERSION = '2.0.0';
// ops-tools 源码从 GitHub Release 下载，不打包进 exe
const OPS_TOOLS_ZIP_URL = `https://github.com/yuyangma995-a11y/ops-tools/releases/download/v${INSTALLER_VERSION}/ops-tools-src.zip`;
let srcRoot = null; // 安装时从解压目录动态设置
const destRoot = path.join(process.env.USERPROFILE || process.env.HOME, 'ops-helper');
const backupRoot = path.join(os.tmpdir(), `ops-helper-backup-${Date.now()}`);
const startupDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const vbsPath = path.join(startupDir, 'ops-helper.vbs');
const startupCmdPath = path.join(startupDir, 'ops-helper.cmd');
const localStartCmdPath = path.join(destRoot, 'start-helper.cmd');
const toolDirs = ['workbench', 'visual-prompt', 'prompt-tool', 'perf-tool', 'combo', 'ops-war-room', 'activity-tool'];
const preserveFiles = ['api.config.json', 'apps.custom.json', 'tools.config.json', 'feishu.config.json', 'auth.whitelist.json', 'auth.machines.json', 'auth.secret'];
const preserveDirs = ['visual-data'];

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function removeDir(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function run(command) {
  try {
    child_process.execSync(command, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function escapePs(value) {
  return String(value).replace(/'/g, "''");
}

function stopOldHelper() {
  console.log('Stopping old helper service and freeing port 9999...');
  if (process.platform === 'win32') {
    const destNeedle = escapePs(destRoot.replace(/\\/g, '\\\\'));
    run(`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ids=@(); $ids += Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and ($_.CommandLine -like '*ops-helper*helper.js*' -or $_.CommandLine -like '*${destNeedle}*helper.js*') } | Select-Object -ExpandProperty ProcessId; try { $ids += Get-NetTCPConnection -LocalPort 9999 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess } catch {}; $ids | Where-Object { $_ } | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"`);
    run(`wmic process where "name='node.exe' and commandline like '%ops-helper%helper.js%'" call terminate`);
  } else {
    run(`pkill -f "${path.join(destRoot, 'helper.js').replace(/"/g, '\\"')}"`);
  }
}

function removeOldStartupLaunchers() {
  for (const file of [vbsPath, startupCmdPath]) {
    try {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    } catch {}
  }
}

function backupOldData() {
  if (!fs.existsSync(destRoot)) return;
  fs.mkdirSync(backupRoot, { recursive: true });
  for (const file of preserveFiles) {
    const src = path.join(destRoot, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupRoot, file));
  }
  for (const dir of preserveDirs) {
    const src = path.join(destRoot, dir);
    if (fs.existsSync(src)) copyDir(src, path.join(backupRoot, dir));
  }
  console.log('Backed up API config and local project data.');
}

function restoreOldData() {
  if (!fs.existsSync(backupRoot)) return;
  for (const file of preserveFiles) {
    const src = path.join(backupRoot, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(destRoot, file));
  }
  for (const dir of preserveDirs) {
    const src = path.join(backupRoot, dir);
    if (fs.existsSync(src)) copyDir(src, path.join(destRoot, dir));
  }
  removeDir(backupRoot);
  console.log('Restored API config and local project data.');
}

function cleanInstallDir() {
  backupOldData();
  removeDir(destRoot);
  fs.mkdirSync(destRoot, { recursive: true });
}

function vbsEscape(value) {
  return String(value).replace(/"/g, '""');
}

function writeStartupLauncher() {
  fs.mkdirSync(startupDir, { recursive: true });
  const nodePath = process.execPath;
  const helperPath = path.join(destRoot, 'helper.js');
  const cmdPath = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const cmdLines = [
    '@echo off',
    `cd /d "${destRoot}"`,
    `"${nodePath}" "${helperPath}"`
  ];
  fs.writeFileSync(localStartCmdPath, cmdLines.join('\r\n') + '\r\n', 'utf8');
  fs.copyFileSync(localStartCmdPath, startupCmdPath);
  const lines = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.CurrentDirectory = "${vbsEscape(destRoot)}"`,
    `WshShell.Run """${vbsEscape(cmdPath)}"" /c """"${vbsEscape(localStartCmdPath)}""""", 0, False`
  ];
  fs.writeFileSync(vbsPath, lines.join('\r\n') + '\r\n', 'utf8');
  console.log('Startup launcher configured.');
}

function startHelperHidden() {
  const helperPath = path.join(destRoot, 'helper.js');
  child_process.spawn(process.execPath, [helperPath], {
    cwd: destRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  }).unref();
  console.log('Service launched by detached Node process.');
}

function fetchText(url) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', () => resolve({ status: 0, data: '' }));
    req.setTimeout(1800, () => { req.destroy(); resolve({ status: 0, data: '' }); });
  });
}

function downloadFile(url, destPath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'yuziyuan-installer/2.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        return resolve(downloadFile(res.headers.location, destPath, redirectCount + 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

async function downloadAndExtractOpsTools() {
  const tmpZip = path.join(os.tmpdir(), `ops-tools-src-${Date.now()}.zip`);
  const tmpExtract = path.join(os.tmpdir(), `ops-tools-extract-${Date.now()}`);
  console.log('Downloading ops-tools from GitHub...');
  console.log('URL:', OPS_TOOLS_ZIP_URL);
  await downloadFile(OPS_TOOLS_ZIP_URL, tmpZip);
  console.log('Download complete. Extracting...');
  fs.mkdirSync(tmpExtract, { recursive: true });
  if (process.platform === 'win32') {
    child_process.execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpExtract}' -Force"`,
      { stdio: 'inherit' }
    );
  } else {
    child_process.execSync(`unzip -q "${tmpZip}" -d "${tmpExtract}"`, { stdio: 'inherit' });
  }
  try { fs.rmSync(tmpZip, { force: true }); } catch {}
  // zip 根目录可能是 ops-tools/ 或直接是文件
  const entries = fs.readdirSync(tmpExtract);
  const opsDir = path.join(tmpExtract, 'ops-tools');
  if (entries.length === 1 && fs.statSync(path.join(tmpExtract, entries[0])).isDirectory()) {
    return path.join(tmpExtract, entries[0]);
  } else if (fs.existsSync(opsDir)) {
    return opsDir;
  }
  return tmpExtract;
}

async function waitForNewService() {
  for (let i = 0; i < 18; i++) {
    const ping = await fetchText('http://127.0.0.1:9999/ping');
    const workbench = await fetchText('http://127.0.0.1:9999/workbench/index.html');
    const oldWorkbench = await fetchText('http://127.0.0.1:9999/%E5%B7%A5%E4%BD%9C%E5%8F%B0/index.html');
    const visual = await fetchText('http://127.0.0.1:9999/visual-prompt/index.html');
    const oldVisual = await fetchText('http://127.0.0.1:9999/%E8%A7%86%E8%A7%89Prompt%E5%B7%A5%E4%BD%9C%E5%8F%B0/index.html');
    
    const xlsx = await fetchText('http://127.0.0.1:9999/visual-prompt/vendor/xlsx.full.min.js');
    const ops = await fetchText('http://127.0.0.1:9999/ops-war-room/index.html');
    if (
      ping.data.includes(BUILD) &&
      workbench.data.includes('/visual-prompt/index.html') &&
      oldWorkbench.data.includes('/visual-prompt/index.html') &&
      visual.data.includes('视觉做图工作台') &&
      oldVisual.data.includes('视觉做图工作台') &&
      ping.data.includes('auth-2026-06-08') &&
      xlsx.status === 200 &&
      ops.status === 200
    ) return true;
    await new Promise(r => setTimeout(r, 900));
  }
  return false;
}

function copyFreshFiles() {
  fs.copyFileSync(path.join(srcRoot, 'helper', 'helper.js'), path.join(destRoot, 'helper.js'));
  fs.copyFileSync(path.join(srcRoot, 'helper', 'apps.config.json'), path.join(destRoot, 'apps.config.json'));
  // v2.0: 复制登录页、管理后台、配置模板
  const loginHtml = path.join(srcRoot, 'login.html');
  if (fs.existsSync(loginHtml)) { fs.copyFileSync(loginHtml, path.join(destRoot, 'login.html')); console.log('Copied: login.html'); }
  const adminDir = path.join(srcRoot, 'admin');
  if (fs.existsSync(adminDir)) { copyDir(adminDir, path.join(destRoot, 'admin')); console.log('Copied: admin/'); }
  const feishuExample = path.join(srcRoot, 'helper', 'feishu.config.example.json');
  if (fs.existsSync(feishuExample)) { fs.copyFileSync(feishuExample, path.join(destRoot, 'feishu.config.example.json')); }
  const whitelistExample = path.join(srcRoot, 'helper', 'auth.whitelist.example.json');
  if (fs.existsSync(whitelistExample)) { fs.copyFileSync(whitelistExample, path.join(destRoot, 'auth.whitelist.example.json')); }
  console.log('Copied: helper.js');
  for (const dir of toolDirs) {
    copyDir(path.join(srcRoot, dir), path.join(destRoot, dir));
    console.log('Copied:', dir);
  }
}

(async () => {
  console.log('===============================================');
  console.log('Yuziyuan Ops Tools Installer (Auth v2.0 - 2026-06-08)');
  console.log('===============================================');
  console.log('Node.js:', process.version);
  console.log('Node.exe:', process.execPath);
  console.log('Install to:', destRoot);

  // 下载 ops-tools 源码（从 GitHub Release）
  try {
    srcRoot = await downloadAndExtractOpsTools();
    console.log('ops-tools extracted to:', srcRoot);
  } catch (err) {
    console.error('ERROR: Failed to download ops-tools:', err.message);
    console.error('Please check your internet connection and try again.');
    process.exitCode = 1;
    return;
  }

  stopOldHelper();
  removeOldStartupLaunchers();
  await new Promise(r => setTimeout(r, 1200));
  cleanInstallDir();
  copyFreshFiles();
  restoreOldData();
  removeOldStartupLaunchers();
  writeStartupLauncher();

  stopOldHelper();
  await new Promise(r => setTimeout(r, 800));
  startHelperHidden();
  console.log('Service starting...');

  const ok = await waitForNewService();
  if (!ok) {
    console.log('ERROR: New service did not verify.');
    console.log('Please close all old command windows, then run install-win.bat again.');
    console.log('After install, check: http://127.0.0.1:9999/ping');
    process.exitCode = 1;
    return;
  }
  console.log('Install verified. You can close this window.');
  console.log('Open: http://127.0.0.1:9999');
})();
