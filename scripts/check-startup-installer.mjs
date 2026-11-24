// Regression checks use the lifecycle function bodies from startup-hooks.nsh.
// Registry reads/path checks and System::Call are in-memory mocks. No installer
// is executed, no real registry is accessed, and this is not native lifecycle QA.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const hooks = read('src-tauri/windows/startup-hooks.nsh');
const template = read('src-tauri/windows/installer.nsi').replaceAll('\r\n', '\n');
const upstreamBytes = readFileSync(path.join(root, 'src-tauri/windows/installer.upstream.nsi'));
const upstream = upstreamBytes.toString('utf8').replaceAll('\r\n', '\n');
const command = (exe) => `"${exe}" --autostart`;
const tokens = (line) => line.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
const funcs = new Map([...hooks.matchAll(/^Function ([\w.]+)\r?\n([\s\S]*?)^FunctionEnd/gm)]
  .map((match) => [match[1], match[2].split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith(';'))]));

// Only NSIS control flow/instructions in the three lifecycle functions are
// interpreted; the Windows APIs below are deliberately replaceable storage.
function simulate(initial, previousDirectory = '', options = {}) {
  const vars = { ShiyeStartupPreviousDirectory: previousDirectory, INSTDIR: options.installDirectory ?? 'C:\\新 目录\\拾页' };
  let registry = initial ? { ...initial } : null;
  let reads = 0;
  const writes = [];
  const registers = [];
  const value = (token) => {
    const text = /^['"]/.test(token) ? token.slice(1, -1) : token;
    return text.replaceAll('${MAINBINARYNAME}', 'shiye').replaceAll('$\\"', '"')
      .replace(/\$([A-Za-z_][A-Za-z_\d]*|\d)/g, (_, name) => String(vars[name] ?? ''));
  };
  const condition = (parts) => {
    const [left, op, right] = parts.map(value);
    if (op === '=' || op === '<>' || op === '>' || op === '<') {
      const a = Number(left), b = Number(right);
      return op === '=' ? a === b : op === '<>' ? a !== b : op === '>' ? a > b : a < b;
    }
    if (op === 'S!=') return left !== right;
    if (op === '!=') return left.toLowerCase() !== right.toLowerCase();
    throw new Error(`Unsupported condition ${parts.join(' ')}`);
  };
  const readRegistry = () => {
    reads += 1;
    if (reads === options.changeAtRead) registry = options.changedValue ? { ...options.changedValue } : null;
    vars.ShiyeStartupError = reads === options.failRead ? 5 : 0;
    vars.ShiyeStartupState = registry ? (registry.type === 1 && registry.command.length <= 260 ? 'string' : 'other') : 'missing';
    vars.ShiyeStartupCommand = registry?.command ?? '';
    vars.ShiyeStartupBytes = registry ? (registry.command.length + 1) * 2 : 0;
  };
  const checkOwned = () => {
    // Models the CommandLineToArgvW/GetFullPathNameW boundary, never executes it.
    const target = /^"([^"]+)"(?:\s|$)/.exec(vars.ShiyeStartupCommand)?.[1]
      ?? /^[^\s]+/.exec(vars.ShiyeStartupCommand)?.[0] ?? '';
    const absolute = /^[a-z]:[\\/]|^\\\\/i.test(target);
    const normalize = (item) => path.win32.normalize(item).toLowerCase();
    vars.ShiyeStartupOwned = vars.ShiyeStartupState === 'string' && absolute
      && normalize(target) === normalize(vars.ShiyeStartupExpectedPath) ? 1 : 0;
  };
  const call = (name) => {
    if (name.endsWith('ShiyeStartupRead')) return readRegistry();
    if (name.endsWith('ShiyeStartupCheckOwned')) return checkOwned();
    const lines = funcs.get(name);
    assert.ok(lines, `Known NSIS function ${name}`);
    const execute = (start, end) => {
      for (let i = start; i < end; i += 1) {
        const line = lines[i];
        const args = tokens(line);
        if (args[0] === '${If}') {
          let guard = condition(args.slice(1));
          while (['${OrIf}', '${AndIf}'].includes(tokens(lines[i + 1] ?? '')[0])) {
            const next = tokens(lines[++i]);
            guard = next[0] === '${OrIf}' ? guard || condition(next.slice(1)) : guard && condition(next.slice(1));
          }
          const bodyStart = i + 1;
          let depth = 1, otherwise = -1, stop = bodyStart;
          for (; stop < end; stop += 1) {
            const kind = tokens(lines[stop])[0];
            if (kind === '${If}') depth += 1;
            if (kind === '${EndIf}' && --depth === 0) break;
            if (kind === '${Else}' && depth === 1) otherwise = stop;
          }
          assert.equal(depth, 0, 'Balanced lifecycle conditional');
          if (guard) execute(bodyStart, otherwise === -1 ? stop : otherwise);
          else if (otherwise !== -1) execute(otherwise + 1, stop);
          i = stop;
        } else if (args[0] === 'Goto') {
          throw { jump: args[1] };
        } else if (args[0] === 'StrCpy') {
          vars[args[1].slice(1)] = value(args[2]);
        } else if (args[0] === 'StrLen') {
          vars[args[1].slice(1)] = value(args[2]).length;
        } else if (args[0] === 'IntOp') {
          const a = Number(value(args[2])), b = Number(value(args[4]));
          vars[args[1].slice(1)] = args[3] === '+' ? a + b : a * b;
        } else if (args[0] === 'ReadRegStr') {
          vars[args[1].slice(1)] = previousDirectory;
        } else if (args[0] === 'Call') {
          call(args[1]);
        } else if (args[0] === 'System::Store') {
          if (value(args[1]) === 's') registers.push(Object.fromEntries(Object.entries(vars).filter(([key]) => /^\d$/.test(key))));
          else {
            for (const key of Object.keys(vars)) if (/^\d$/.test(key)) delete vars[key];
            Object.assign(vars, registers.pop());
          }
        } else if (args[0] === 'System::Call') {
          if (line.includes('RegOpenKeyExW')) {
            vars[line.includes('.r3') ? '3' : '0'] = options.failOpen ?? 0;
          } else if (line.includes('RegSetValueExW')) {
            vars['3'] = options.failWrite ?? 0;
            if (!vars['3']) { registry = { type: 1, command: vars['0'] }; writes.push({ set: { ...registry } }); }
          } else if (line.includes('RegDeleteValueW')) {
            vars['0'] = options.failDelete ?? 0;
            if (!vars['0']) { registry = null; writes.push({ delete: true }); }
          } else assert.ok(line.includes('RegCloseKey'), `Known mock API ${line}`);
        } else if (args[0] === '!insertmacro' && args[1] === 'ShiyeStartupFailure') {
          throw new Error(value(args[2]));
        } else assert.ok(line.endsWith(':') || args[0] === 'DetailPrint', `Known instruction ${line}`);
      }
    };
    try { execute(0, lines.length); }
    catch (error) {
      if (!error.jump) throw error;
      const label = lines.indexOf(`${error.jump}:`);
      assert.ok(label >= 0, 'Known goto label');
      execute(label + 1, lines.length);
    }
  };
  return { call, vars, writes, get registry() { return registry; } };
}

test('template retains the locked upstream and only the documented patches', () => {
  assert.equal(createHash('sha256').update(upstreamBytes).digest('hex'), '20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079');
  let expected = upstream.replace('{{#if installer_hooks}}\n!include "{{installer_hooks}}"\n{{/if}}\n\n', '');
  expected = expected.replace('Var OldMainBinaryName\n', 'Var OldMainBinaryName\n\n{{#if installer_hooks}}\n!include "{{installer_hooks}}"\n{{/if}}\n');
  expected = expected.replace('      ${IfThen} $UpdateMode = 1 ${|} StrCpy $R1 "$R1 /UPDATE" ${|} ; append /UPDATE', '      ; This old uninstaller is part of a replacement install, including\n      ; same-version reinstalls. Direct uninstall.exe remains a normal uninstall.\n      StrCpy $R1 "$R1 /UPDATE"');
  expected = expected.replace('  !insertmacro SetContext\n\n  ${If} $INSTDIR', '  !insertmacro SetContext\n\n  Call ShiyeStartupSnapshot\n\n  ${If} $INSTDIR');
  expected = expected.replace(/  ; Removes the Autostart entry[\s\S]*?DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "\$\{PRODUCTNAME\}"\n  \$\{EndIf\}/, '  ; The startup hook removes only our fixed Run value when its executable\n  ; matches this installation. Other copies and productName values are preserved.');
  assert.equal(template.slice(template.indexOf('Unicode true')), expected);
  assert.ok(template.indexOf('!define BUNDLEID') < template.indexOf('!include "{{installer_hooks}}"'));
  assert.match(template, /Function \.onInit[\s\S]*?Call ShiyeStartupSnapshot[\s\S]*?FunctionEnd/);
  assert.doesNotMatch(template, /DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run"/);
  const config = JSON.parse(read('src-tauri/tauri.conf.json')).bundle.windows.nsis;
  assert.equal(config.template, './windows/installer.nsi');
  assert.equal(config.installerHooks, './windows/startup-hooks.nsh');
});

test('identity is compiled from the bundle identifier and cleanup checks UPDATE, not passive mode', () => {
  assert.match(hooks, /!if "\$\{BUNDLEID\}" == "local\.shiye\.workbench"/);
  assert.match(hooks, /!else if "\$\{BUNDLEID\}" == "local\.shiye\.workbench\.startupqa"/);
  assert.match(hooks, /!error "Unsupported Shiye installer identity/);
  assert.doesNotMatch(hooks, /ReadEnvStr|StartupApproved.*::|\$PassiveMode/);
  assert.match(hooks, /!macro NSIS_HOOK_POSTUNINSTALL\s+\$\{If\} \$UpdateMode <> 1\s+Call un\.ShiyeStartupCleanup/);
});

test('fresh/disabled installations and another registered copy remain unchanged', () => {
  for (const initial of [null, { type: 1, command: command('D:\\另一 副本\\shiye.exe') }, { type: 2, command: command('C:\\old\\shiye.exe') }]) {
    const run = simulate(initial, 'C:\\old');
    run.call('ShiyeStartupSnapshot'); run.call('ShiyeStartupRelocate');
    assert.deepEqual(run.registry, initial); assert.equal(run.writes.length, 0);
  }
});

test('enabled replacement keeps same path or moves its quoted Unicode path', () => {
  const initial = { type: 1, command: command('C:\\old\\shiye.exe') };
  for (const directory of ['C:\\old', 'D:\\中文 空格\\拾页']) {
    const run = simulate(initial, 'C:\\old', { installDirectory: directory });
    run.call('ShiyeStartupSnapshot');
    assert.equal(run.writes.length, 0, 'snapshot is read-only; cancelling before install preserves state');
    run.call('ShiyeStartupRelocate');
    assert.equal(run.registry.command, command(`${directory}\\shiye.exe`));
    assert.equal(run.writes.length, directory === 'C:\\old' ? 0 : 1);
  }
});

test('external deletion, replacement or byte-case changes during installation are preserved', () => {
  const initial = { type: 1, command: command('C:\\old\\shiye.exe') };
  for (const changedValue of [null, { type: 1, command: command('D:\\other\\shiye.exe') }, { type: 1, command: command('C:\\OLD\\shiye.exe') }]) {
    const run = simulate(initial, 'C:\\old', { changeAtRead: 2, changedValue });
    run.call('ShiyeStartupSnapshot'); run.call('ShiyeStartupRelocate');
    assert.deepEqual(run.registry, changedValue); assert.equal(run.writes.length, 0);
  }
});

test('overlong new path and registry failures are explicit and preserve prewrite state', () => {
  const initial = { type: 1, command: command('C:\\old\\shiye.exe') };
  for (const options of [{ installDirectory: `D:\\${'长'.repeat(260)}` }, { failRead: 1 }, { failRead: 2 }, { failWrite: 5 }, { failOpen: 5 }]) {
    const run = simulate(initial, 'C:\\old', options);
    assert.throws(() => { run.call('ShiyeStartupSnapshot'); run.call('ShiyeStartupRelocate'); }, /无法|超过/);
    assert.deepEqual(run.registry, initial); assert.equal(run.writes.length, 0);
  }
  const readBack = simulate(initial, 'C:\\old', { failRead: 3 });
  readBack.call('ShiyeStartupSnapshot');
  assert.throws(() => readBack.call('ShiyeStartupRelocate'), /无法确认/);
  assert.equal(readBack.writes.length, 1, 'reports partial result after a successful write but failed verification');
});

test('normal uninstall deletes only the matching absolute executable and is idempotent', () => {
  const directory = 'D:\\中文 空格\\拾页';
  const own = { type: 1, command: command(`${directory}\\shiye.exe`) };
  const remove = simulate(own, '', { installDirectory: directory });
  remove.call('un.ShiyeStartupCleanup'); remove.call('un.ShiyeStartupCleanup');
  assert.equal(remove.registry, null); assert.equal(remove.writes.length, 1);
  for (const entry of [{ type: 1, command: command(`${directory} extra\\shiye.exe`) }, { type: 1, command: command('shiye.exe') }, { type: 1, command: command('D:\\other\\shiye.exe') }, { type: 2, command: own.command }]) {
    const keep = simulate(entry, '', { installDirectory: directory }); keep.call('un.ShiyeStartupCleanup');
    assert.deepEqual(keep.registry, entry); assert.equal(keep.writes.length, 0);
  }
});

test('uninstall read/delete/readback failures report remaining or unconfirmed startup state', () => {
  const initial = { type: 1, command: command('C:\\old\\shiye.exe') };
  for (const options of [{ failRead: 1 }, { failDelete: 5 }, { failOpen: 5 }]) {
    const run = simulate(initial, '', { ...options, installDirectory: 'C:\\old' });
    assert.throws(() => run.call('un.ShiyeStartupCleanup'), /无法/); assert.deepEqual(run.registry, initial);
  }
  const run = simulate(initial, '', { failRead: 2, installDirectory: 'C:\\old' });
  assert.throws(() => run.call('un.ShiyeStartupCleanup'), /无法确认/); assert.equal(run.registry, null);
});
