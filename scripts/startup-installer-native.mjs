// Native QA installer lifecycle only. Never runs the workbench application.
// node scripts/startup-installer-native.mjs [startupqa installer path]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, copyFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qaTarget = path.join(workspace, 'src-tauri', 'target', 'startup', 'qa');
const installer = path.resolve(process.argv[2] ?? path.join(qaTarget, 'bundle', 'nsis', '拾页自启动验收_0.1.0_x64-setup.exe'));
const sourceExe = path.join(qaTarget, 'shiye-startup-qa.exe');
const generatedTemplate = path.join(qaTarget, 'nsis', 'x64', 'installer.nsi');
const probe = path.join(workspace, 'scripts', 'startup-native-probe.ps1');
const reportPath = path.join(workspace, 'docs', 'verification', 'raw', 'startup-installer-native.json');
const fixture = path.join(workspace, '.qa', `startup-install-${Date.now()}`);
const firstDirectory = path.join(fixture, '中文 空格目录');
const migratedDirectory = path.join(fixture, '迁移 中文目录');
const otherDirectory = path.join(fixture, '另一独立副本');
const appName = 'shiye-startup-qa.exe';
const launchHelper = path.join(fixture, 'installer-runner.ps1');
const command = (directory) => `"${path.join(directory, appName)}" --autostart`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = async (file) => { try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const formalSnapshot = (record) => Object.fromEntries(Object.entries(record).filter(([key]) => key.startsWith('formal')));
const report = {
  startedAt: new Date().toISOString(), installer, executable: sourceExe, generatedTemplate,
  identity: 'local.shiye.workbench.startupqa', fixture,
  scope: 'Current-user isolated NSIS install/replacement/migration/uninstall; /S without /R. No application launch, no real logoff/login. Explicit /UPDATE tests the old-uninstaller branch; silent install bypasses the reinstall GUI.',
  operations: [], checks: [], registry: [], hashes: {}, cleanup: [],
};
const check = (name, details) => { report.checks.push({ name, pass: true, details }); console.log(name); };
let initialRegistry, initialProcesses, sealedExecutableBytes, ownsFixture = false, expectedQa = null;

async function powerShell(args, name) {
  const record = { name, executable: 'pwsh.exe', args, startedAt: new Date().toISOString() };
  report.operations.push(record);
  const result = await new Promise((resolve, reject) => {
    const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ...args], {
      cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    record.processId = child.pid;
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (part) => { stdout += part; }); child.stderr.on('data', (part) => { stderr += part; });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
  Object.assign(record, result, { endedAt: new Date().toISOString() });
  assert.equal(result.exitCode, 0, `${name}: ${result.stderr || result.stdout}`);
  return result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null;
}

async function readRegistry(name) {
  const record = await powerShell([probe, '-Action', 'read'], name);
  report.registry.push({ name, time: new Date().toISOString(), ...record });
  if (initialRegistry) assert.deepEqual(formalSnapshot(record), formalSnapshot(initialRegistry), 'Formal Run value/type/hash must remain unchanged');
  return record;
}

async function expectQa(name, expected = expectedQa) {
  const record = await readRegistry(name);
  assert.equal(record.qa, expected, `${name}: actual QA Run command`);
  return record;
}

async function writeQa(value, name) {
  await expectQa(`${name}: before fixture write`);
  await powerShell([probe, '-Action', 'write', '-Value', value], name);
  expectedQa = value;
  await expectQa(`${name}: after fixture write`);
}

async function native(directory, action, name, update = false) {
  const executable = action === 'install' ? installer : path.join(directory, 'uninstall.exe');
  report.hashes[executable] = sha256(await readFile(executable));
  const result = await powerShell([launchHelper, '-Action', action, '-Executable', executable, '-Directory', directory,
    ...(update ? ['-Update'] : [])], name);
  Object.assign(report.operations.at(-1), { nativeProcessId: result.processId, nativeExitCode: result.exitCode, nativeArguments: result.arguments });
  assert.equal(result.exitCode, 0, `${name}: native installer/uninstaller exit code`);
  if (action === 'install') {
    assert.ok(await exists(path.join(directory, appName)), `${name}: expected isolated application was installed`);
    assert.ok(await exists(path.join(directory, 'uninstall.exe')), `${name}: uninstall.exe exists`);
    const installedBytes = await readFile(path.join(directory, appName));
    report.hashes[path.join(directory, appName)] = sha256(installedBytes);
    // Tauri 2.9.4 patches UNK -> NSS for the bundle, then restores the standalone
    // binary. Admit exactly that documented marker change and no other bytes.
    const standaloneMarker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
    const nsisMarker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');
    const markerOffset = sealedExecutableBytes.indexOf(standaloneMarker);
    assert.ok(markerOffset >= 0, 'Sealed standalone bundle marker exists');
    assert.equal(sealedExecutableBytes.indexOf(standaloneMarker, markerOffset + 1), -1, 'Bundle marker is unique');
    const expectedPayload = Buffer.from(sealedExecutableBytes);
    nsisMarker.copy(expectedPayload, markerOffset);
    assert.ok(installedBytes.equals(expectedPayload), 'Installed bytes match sealed QA executable with only the documented NSIS bundle marker patch');
    const normalized = Buffer.from(installedBytes);
    standaloneMarker.copy(normalized, markerOffset);
    assert.equal(sha256(normalized), report.hashes[sourceExe], 'Normalized installed application hash equals the sealed standalone QA executable');
    if (!report.binaryNormalization) {
      const inspectionPath = path.join(fixture, 'installed-inspection.exe');
      await writeFile(inspectionPath, installedBytes);
      report.binaryNormalization = {
        source: 'https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle.rs',
        explanation: 'tauri-bundler 2.9.4 patch_binary changes the unique bundle marker for NSIS, then bundle_project restores the original standalone binary.',
        markerOffset, standaloneMarker: standaloneMarker.toString(), installedMarker: nsisMarker.toString(),
        sourceBytes: sealedExecutableBytes.length, installedBytes: installedBytes.length,
        standaloneSha256: report.hashes[sourceExe], installedSha256: sha256(installedBytes), normalizedSha256: sha256(normalized), inspectionPath,
        differences: [...standaloneMarker.keys()].filter((index) => standaloneMarker[index] !== nsisMarker[index])
          .map((index) => ({ offset: markerOffset + index, standalone: standaloneMarker[index], installed: nsisMarker[index] })),
        allOtherBytesIdentical: true,
      };
    }
  } else {
    assert.equal(await exists(path.join(directory, appName)), false, `${name}: isolated application removed`);
    // _?= keeps the original uninstaller process instead of its temp copy.
    // After Wait has completed, remove that fixture-owned executable if locked
    // self-deletion left it behind. Its identity/hash were verified above.
    if (await exists(executable)) await unlink(executable);
  }
}

const helperSource = String.raw`param(
  [ValidateSet('inspect','install','uninstall','cleanup')][string]$Action,
  [string]$Executable = '', [string]$Directory = '', [switch]$Update
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$fixtureRoot = '${fixture.replaceAll("'", "''")}'
$qaProductName = '拾页自启动验收'
$metadataPath = 'Software\shiye\拾页自启动验收'
$uninstallPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\拾页自启动验收'
$registryRoot = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
try {
  if ($Action -eq 'inspect') {
    $metadataKey = $registryRoot.OpenSubKey($metadataPath)
    $uninstallKey = $registryRoot.OpenSubKey($uninstallPath)
    try {
      @{ productName=[Diagnostics.FileVersionInfo]::GetVersionInfo($Executable).ProductName
        qaProcesses=@(Get-Process -Name 'shiye-startup-qa' -ErrorAction SilentlyContinue | ForEach-Object { @{processId=$_.Id; path=$_.Path} })
        formalProcesses=@(Get-Process -Name 'shiye' -ErrorAction SilentlyContinue | ForEach-Object { @{processId=$_.Id; path=$_.Path} })
        metadataExists=($null -ne $metadataKey); uninstallEntryExists=($null -ne $uninstallKey)
      } | ConvertTo-Json -Depth 5 -Compress
    } finally { if ($metadataKey) {$metadataKey.Dispose()}; if ($uninstallKey) {$uninstallKey.Dispose()} }
    exit
  }
  if ($Action -eq 'cleanup') {
    $uninstallKey = $registryRoot.OpenSubKey($uninstallPath)
    if ($uninstallKey) { $uninstallKey.Dispose(); throw 'QA uninstall entry remains; refusing to hide a failed uninstall.' }
    $metadataKey = $registryRoot.OpenSubKey($metadataPath)
    if ($metadataKey) {
      try { $registeredDirectory = [string]$metadataKey.GetValue('') } finally { $metadataKey.Dispose() }
      $resolvedRegisteredDirectory = [IO.Path]::GetFullPath($registeredDirectory)
      if (-not $resolvedRegisteredDirectory.StartsWith($fixtureRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'QA installation metadata points outside this fixture; preserve it.' }
      $registryRoot.DeleteSubKeyTree($metadataPath, $false)
    }
    @{metadataCleaned=$true} | ConvertTo-Json -Compress
    exit
  }
  $resolvedDirectory = [IO.Path]::GetFullPath($Directory)
  if (-not $resolvedDirectory.StartsWith($fixtureRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installation directory escaped the isolated workspace fixture.' }
  if (@(Get-Process -Name 'shiye-startup-qa' -ErrorAction SilentlyContinue).Count -ne 0) { throw 'An isolated QA application is running; refusing NSIS process termination.' }
  if ([Diagnostics.FileVersionInfo]::GetVersionInfo($Executable).ProductName -ne $qaProductName) { throw 'Executable product identity is not startupqa.' }
  if ($Action -eq 'uninstall' -and [IO.Path]::GetFullPath($Executable) -ne (Join-Path $resolvedDirectory 'uninstall.exe')) { throw 'Uninstaller escaped this fixture.' }
  # NSIS /D and _?= must be the last option, with the path unquoted. This is
  # passed as an argument string to Start-Process; it is never shell-evaluated.
  $nativeArguments = if ($Action -eq 'install') { "/S /D=$resolvedDirectory" } elseif ($Update) { "/S /UPDATE _?=$resolvedDirectory" } else { "/S _?=$resolvedDirectory" }
  $nativeProcess = Start-Process -FilePath $Executable -ArgumentList $nativeArguments -Wait -PassThru -WindowStyle Hidden
  @{processId=$nativeProcess.Id; exitCode=$nativeProcess.ExitCode; arguments=$nativeArguments} | ConvertTo-Json -Compress
} finally { $registryRoot.Dispose() }
`;

try {
  assert.ok(installer.startsWith(path.join(qaTarget, 'bundle', 'nsis') + path.sep), 'Installer must be inside this startupqa target directory');
  const source = await readFile(generatedTemplate, 'utf8');
  const define = (name) => new RegExp(`^!define ${name} "([^"\\r\\n]*)"`, 'm').exec(source)?.[1];
  assert.equal(define('BUNDLEID'), 'local.shiye.workbench.startupqa');
  assert.equal(define('PRODUCTNAME'), '拾页自启动验收');
  assert.equal(define('MAINBINARYNAME'), 'shiye-startup-qa');
  // Sealing a build into startup/qa preserves the original generated NSIS
  // source path. Only these two known startupqa binary locations are accepted;
  // each installed binary must still hash-match the sealed QA executable.
  const bundledSourcePath = path.resolve(define('MAINBINARYSRCPATH'));
  assert.ok([sourceExe, path.join(workspace, 'src-tauri', 'target', 'startup', 'release', appName)].includes(bundledSourcePath), 'Bundle source must be the isolated startupqa executable');
  report.bundledSourcePath = bundledSourcePath;
  assert.ok(source.includes(`!include "${path.join(workspace, 'src-tauri', 'windows', 'startup-hooks.nsh')}"`), 'Generated template must use the audited startupqa hooks');
  assert.match(source, /Call ShiyeStartupSnapshot/);
  assert.doesNotMatch(source, /DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run"/);
  const hookBytes = await readFile(path.join(workspace, 'src-tauri', 'windows', 'startup-hooks.nsh'));
  assert.match(hookBytes.toString('utf8'), /!else if "\$\{BUNDLEID\}" == "local\.shiye\.workbench\.startupqa"\s+!define SHIYE_STARTUP_VALUE "local\.shiye\.workbench\.startupqa"/);
  for (const full of [installer, sourceExe, generatedTemplate, probe]) report.hashes[full] = sha256(await readFile(full));
  sealedExecutableBytes = await readFile(sourceExe);
  assert.equal(sha256(sealedExecutableBytes), report.hashes[sourceExe], 'QA executable must remain sealed during preflight');
  report.hashes['startup-hooks.nsh'] = sha256(hookBytes);
  await mkdir(fixture, { recursive: true });
  await writeFile(launchHelper, helperSource, 'utf8');
  initialRegistry = await readRegistry('initial Run values');
  assert.equal(initialRegistry.qa, null, 'The isolated QA Run value must be absent before testing; preserve any existing QA registration');
  initialProcesses = await powerShell([launchHelper, '-Action', 'inspect', '-Executable', installer], 'initial identity/process/metadata inspection');
  assert.equal(initialProcesses.productName, '拾页自启动验收');
  assert.equal(initialProcesses.qaProcesses.length, 0, 'Finish the separate QA smoke process before installer testing');
  assert.equal(initialProcesses.metadataExists, false, 'Existing QA installation metadata must be absent; preserve any existing QA installation');
  assert.equal(initialProcesses.uninstallEntryExists, false, 'Existing QA uninstall entry must be absent');
  ownsFixture = true;
  await native(firstDirectory, 'install', 'fresh silent install'); await expectQa('fresh installation leaves startup off');
  check('Fresh Unicode/space installation does not register autostart');
  await native(firstDirectory, 'install', 'disabled same-version silent replacement'); await expectQa('disabled replacement remains off');
  await native(firstDirectory, 'uninstall', 'disabled update-mode old uninstall', true); await expectQa('disabled update uninstall remains off');
  await native(firstDirectory, 'install', 'disabled replacement after update uninstall'); await expectQa('disabled update reinstall remains off');
  check('Disabled silent replacement and update-mode uninstall/reinstall remain disabled');
  await writeQa(command(firstDirectory), 'enable isolated current-copy fixture');
  await native(firstDirectory, 'install', 'enabled same-version silent replacement'); await expectQa('enabled silent replacement retains original command');
  await native(firstDirectory, 'uninstall', 'enabled update-mode old uninstall', true); await expectQa('enabled update uninstall preserves Run value');
  await native(firstDirectory, 'install', 'enabled replacement after update uninstall'); await expectQa('enabled update reinstall preserves Run value');
  check('Enabled same-version replacement and explicit old-uninstaller /UPDATE preserve autostart');
  await native(migratedDirectory, 'install', 'enabled install-directory migration');
  expectedQa = command(migratedDirectory); await expectQa('migration points autostart to the new quoted absolute path');
  check('Enabled installation path migrates between Unicode/space directories');
  await native(firstDirectory, 'uninstall', 'uninstall earlier copy after migration'); await expectQa('earlier-copy uninstall preserves newer-copy Run value');
  check('Uninstalling the earlier installation preserves a newer registered copy');
  await mkdir(otherDirectory, { recursive: true }); await copyFile(sourceExe, path.join(otherDirectory, appName));
  await writeQa(command(otherDirectory), 'point isolated Run value to standalone fixture');
  await native(migratedDirectory, 'uninstall', 'uninstall while another copy owns Run value'); await expectQa('other-copy Run command survives normal uninstall');
  check('Normal uninstall preserves a Run value pointing to a standalone copy');
  await powerShell([probe, '-Action', 'delete'], 'remove standalone QA fixture registration'); expectedQa = null;
  await native(firstDirectory, 'install', 'install for final own-copy cleanup'); await expectQa('final fresh install is still off');
  await writeQa(command(firstDirectory), 'enable final current-copy fixture');
  await native(firstDirectory, 'uninstall', 'normal uninstall cleans own-copy Run value'); expectedQa = null;
  await expectQa('normal uninstall removed own-copy Run value');
  check('Normal uninstall removes only its own fixed QA Run value');
  const finalProcesses = await powerShell([launchHelper, '-Action', 'inspect', '-Executable', installer], 'final process inspection');
  assert.equal(finalProcesses.qaProcesses.length, 0, 'Silent installer tests must never launch the isolated workbench');
  for (const process of initialProcesses.formalProcesses) assert.ok(finalProcesses.formalProcesses.some((item) => item.processId === process.processId), 'The existing formal workbench process remains running');
  check('No QA application was launched; the existing formal process and Run snapshot remain unchanged');
  report.pass = true;
} catch (error) {
  report.pass = false; report.error = { name: error.name, message: error.message, stack: error.stack }; console.error(error);
  process.exitCode = 1;
} finally {
  if (ownsFixture) {
    for (const directory of [firstDirectory, migratedDirectory]) {
      try {
        if (await exists(path.join(directory, 'uninstall.exe'))) await native(directory, 'uninstall', `finally cleanup ${directory}`);
        report.cleanup.push({ directory, appRemoved: !(await exists(path.join(directory, appName))) });
      } catch (error) { report.cleanup.push({ directory, error: error.message }); report.pass = false; process.exitCode = 1; }
    }
    try {
      const current = await readRegistry('final cleanup registration snapshot');
      if (current.qa !== null) {
        assert.ok([command(firstDirectory), command(migratedDirectory), command(otherDirectory)].includes(current.qa), 'Unknown external QA registration is preserved during cleanup');
        await powerShell([probe, '-Action', 'delete'], 'finally delete owned QA fixture registration');
      }
      const last = await readRegistry('after cleanup Run values');
      assert.equal(last.qa, null, 'QA Run registration removed');
      assert.deepEqual(formalSnapshot(last), formalSnapshot(initialRegistry));
      report.cleanup.push({ qaRunRemoved: true, formalRunUnchanged: true });
      await powerShell([launchHelper, '-Action', 'cleanup'], 'remove fixture-owned QA installer metadata');
      report.cleanup.push({ installerMetadataRemoved: true });
    } catch (error) { report.cleanup.push({ error: error.message }); report.pass = false; process.exitCode = 1; }
  }
  report.finishedAt = new Date().toISOString();
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(reportPath);
}
