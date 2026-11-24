use crate::files::{Fault, Result};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Mutex};
use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS},
    System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    },
};

const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME: &str = "local.shiye.workbench";
const QA_VALUE_NAME: &str = "local.shiye.workbench.startupqa";
const MAX_COMMAND_UNITS: usize = 260;
const MAX_VALUE_BYTES: u32 = 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: String,
    pub target: Option<String>,
    pub revision: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub enabled: bool,
    pub revision: String,
}

/// Keep the raw value type and bytes: failed saves must restore even an unfamiliar value exactly.
#[derive(Clone, Debug, PartialEq, Eq)]
struct RawValue {
    kind: u32,
    bytes: Vec<u8>,
}

trait Store: Send {
    fn read(&mut self) -> Result<Option<RawValue>>;
    /// Recheck the snapshot at the write boundary, refusing a known external change.
    fn replace(&mut self, expected: &Option<RawValue>, value: &Option<RawValue>) -> Result<()>;
}

pub struct Autostart {
    store: Mutex<Box<dyn Store>>,
    executable: Result<String>,
    unavailable: Option<String>,
}

impl Autostart {
    /// Construction only selects an identity and resolves the executable; it never opens or writes Run.
    pub fn new(app: &tauri::AppHandle) -> Self {
        let policy = registration_policy(
            &app.config().identifier,
            cfg!(debug_assertions),
            std::env::var_os("SHIYE_DATA_DIR").is_some(),
            std::env::var("SHIYE_AUTOSTART_QA").as_deref() == Ok("1"),
        );
        let value_name = policy.as_ref().copied().unwrap_or(VALUE_NAME);
        let executable = std::env::current_exe()
            .map_err(|e| Fault::new("autostart-path", format!("无法确定当前程序位置：{e}")))
            .and_then(|path| {
                path.to_str().map(normalize_extended_path).ok_or_else(|| {
                    Fault::new("autostart-path", "当前程序位置不是有效 Unicode 路径。")
                })
            });
        Self {
            store: Mutex::new(Box::new(RegistryStore { value_name })),
            executable,
            unavailable: policy.err(),
        }
    }

    pub fn status(&self) -> Status {
        if let Some(message) = &self.unavailable {
            return unavailable_status(message);
        }
        let executable = match &self.executable {
            Ok(path) => path,
            Err(error) => return error_status(&error.message),
        };
        match self.store.lock() {
            Ok(mut store) => match store.read() {
                Ok(value) => snapshot_status(&value, executable),
                Err(error) => error_status(&error.message),
            },
            Err(_) => error_status("自启动操作状态异常，请重启拾页后重试。"),
        }
    }

    /// Serializes the complete settings transaction. Other settings can still save without
    /// touching Run when registration is unavailable or unreadable.
    pub fn update<T>(
        &self,
        change: Option<&Change>,
        save: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let mut store = self
            .store
            .lock()
            .map_err(|_| Fault::new("autostart-lock", "自启动操作状态异常，请重启拾页后重试。"))?;
        let Some(change) = change else {
            return save();
        };
        if let Some(message) = &self.unavailable {
            return Err(Fault::new("autostart-unavailable", message));
        }
        let executable = self.executable.as_ref().map_err(Clone::clone)?;
        let original = store.read()?;
        if snapshot_revision(&original) != change.revision {
            return Err(changed_fault());
        }
        let desired = if change.enabled {
            Some(command_value(executable)?)
        } else if is_current(&original, executable) {
            None
        } else {
            // An absent or other-copy value belongs to someone else; disabling this copy is a no-op.
            original.clone()
        };
        if desired == original {
            return save();
        }
        if let Err(error) = store.replace(&original, &desired) {
            if error.code == "autostart-conflict" {
                // The store rejected before mutation; there is no application change to restore.
                return Err(error);
            }
            return Err(recover(&mut **store, &original, &desired, error));
        }
        let readback = store.read().and_then(|value| {
            if value == desired {
                Ok(())
            } else {
                Err(Fault::new(
                    "autostart-readback",
                    "自启动写入后的系统值不符，未完成保存，请刷新后重试。",
                ))
            }
        });
        if let Err(error) = readback {
            return Err(recover(&mut **store, &original, &desired, error));
        }
        match save() {
            Ok(value) => Ok(value),
            Err(error) => Err(recover(&mut **store, &original, &desired, error)),
        }
    }
}

fn registration_policy(
    identifier: &str,
    debug: bool,
    isolated: bool,
    qa: bool,
) -> std::result::Result<&'static str, String> {
    if debug {
        return Err("开发构建不提供开机自启动，请使用 Windows 发布版。".into());
    }
    if identifier == QA_VALUE_NAME || qa {
        return if identifier == QA_VALUE_NAME && qa {
            Ok(QA_VALUE_NAME)
        } else {
            Err("自启动验收必须同时使用独立应用身份和 SHIYE_AUTOSTART_QA=1。".into())
        };
    }
    if isolated {
        return Err("隔离数据目录运行不修改正式自启动项。".into());
    }
    if identifier != VALUE_NAME {
        return Err("此应用身份不提供正式开机自启动。".into());
    }
    Ok(VALUE_NAME)
}

fn unavailable_status(message: &str) -> Status {
    Status {
        state: "unavailable".into(),
        target: None,
        revision: None,
        message: Some(message.into()),
    }
}

fn error_status(message: &str) -> Status {
    Status {
        state: "error".into(),
        target: None,
        revision: None,
        message: Some(message.into()),
    }
}

fn snapshot_status(value: &Option<RawValue>, executable: &str) -> Status {
    let target = value.as_ref().and_then(command_target);
    let state = if value.is_none() {
        "disabled"
    } else if is_current(value, executable) {
        "enabled"
    } else {
        "other"
    };
    Status {
        state: state.into(),
        target: target.clone(),
        revision: Some(snapshot_revision(value)),
        message: if state == "other" && target.is_none() {
            Some("系统中已有无法识别的自启动值；主动开启可将它切换到当前程序。".into())
        } else {
            None
        },
    }
}

fn normalize_extended_path(path: &str) -> String {
    if let Some(unc) = path.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        path.strip_prefix("\\\\?\\").unwrap_or(path).into()
    }
}

fn path_identity(path: &str) -> String {
    normalize_extended_path(path)
        .replace('/', "\\")
        .to_lowercase()
}

fn command_value(executable: &str) -> Result<RawValue> {
    if !Path::new(executable).is_absolute() || executable.chars().any(|c| c == '"' || c < ' ') {
        return Err(Fault::new(
            "autostart-path",
            "自启动需要可正确引用的当前程序绝对路径。",
        ));
    }
    let command = format!("\"{executable}\" --autostart");
    if command.encode_utf16().count() > MAX_COMMAND_UNITS {
        return Err(Fault::new(
            "autostart-length",
            "自启动命令超过 Windows Run 的 260 字符限制，请将程序移到更短的路径后重试。",
        ));
    }
    Ok(RawValue {
        kind: REG_SZ,
        bytes: command
            .encode_utf16()
            .chain(Some(0))
            .flat_map(u16::to_le_bytes)
            .collect(),
    })
}

fn decode_string(value: &RawValue) -> Option<String> {
    let (bytes, remainder) = value.bytes.as_chunks::<2>();
    if value.kind != REG_SZ || !remainder.is_empty() {
        return None;
    }
    let mut units: Vec<u16> = bytes
        .iter()
        .map(|bytes| u16::from_le_bytes(*bytes))
        .collect();
    // RegQueryValueEx does not guarantee a terminating NUL. Accept its absence, but not embedded NULs.
    if units.last() == Some(&0) {
        units.pop();
    }
    if units.contains(&0) {
        return None;
    }
    String::from_utf16(&units).ok()
}

fn command_target(value: &RawValue) -> Option<String> {
    let command = decode_string(value)?;
    let quoted = command.strip_prefix('"')?;
    let (target, arguments) = quoted.split_once('"')?;
    if !Path::new(target).is_absolute()
        || !(arguments.starts_with(' ') || arguments.starts_with('\t'))
        || arguments.trim() != "--autostart"
    {
        return None;
    }
    Some(normalize_extended_path(target))
}

fn is_current(value: &Option<RawValue>, executable: &str) -> bool {
    value
        .as_ref()
        .and_then(command_target)
        .is_some_and(|target| path_identity(&target) == path_identity(executable))
}

fn snapshot_revision(value: &Option<RawValue>) -> String {
    let mut data = Vec::new();
    match value {
        None => data.push(0),
        Some(raw) => {
            data.push(1);
            data.extend_from_slice(&raw.kind.to_le_bytes());
            data.extend_from_slice(&raw.bytes);
        }
    }
    crate::files::version(&data)
}

fn changed_fault() -> Fault {
    Fault::new(
        "autostart-conflict",
        "自启动项已被其他程序修改，未覆盖该值；请刷新状态后重试。",
    )
}

fn recover(
    store: &mut dyn Store,
    original: &Option<RawValue>,
    desired: &Option<RawValue>,
    error: Fault,
) -> Fault {
    let restored = (|| {
        // A failed write may have left the original untouched. Never overwrite a third-party value.
        if store.read()? == *original {
            return Ok(());
        }
        store.replace(desired, original)?;
        if store.read()? != *original {
            return Err(Fault::new(
                "autostart-restore",
                "恢复后读回的自启动值仍不符。",
            ));
        }
        Ok(())
    })();
    match restored {
        Ok(()) => error,
        Err(restore) => Fault::new(
            "autostart-rollback",
            format!(
                "{} 自启动项恢复失败，可能已发生部分变更：{} 请刷新实际状态后重试。",
                error.message, restore.message
            ),
        ),
    }
}

struct RegistryStore {
    value_name: &'static str,
}

struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0) };
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn registry_fault(code: &str, operation: &str, result: u32) -> Fault {
    Fault::new(
        code,
        format!(
            "无法{operation}当前用户的自启动项：{}（Windows 错误 {result}）。",
            std::io::Error::from_raw_os_error(result as i32)
        ),
    )
}

impl RegistryStore {
    fn open(&self, write: bool, create: bool) -> Result<Option<Key>> {
        let path = wide(RUN_KEY);
        let mut key = std::ptr::null_mut();
        let permissions = KEY_QUERY_VALUE | if write { KEY_SET_VALUE } else { 0 };
        let result = unsafe {
            if create {
                RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    path.as_ptr(),
                    0,
                    std::ptr::null(),
                    REG_OPTION_NON_VOLATILE,
                    permissions,
                    std::ptr::null(),
                    &mut key,
                    std::ptr::null_mut(),
                )
            } else {
                RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, permissions, &mut key)
            }
        };
        match result {
            ERROR_SUCCESS => Ok(Some(Key(key))),
            ERROR_FILE_NOT_FOUND if !create => Ok(None),
            error => Err(registry_fault(
                if write {
                    "autostart-write"
                } else {
                    "autostart-read"
                },
                if write { "写入" } else { "读取" },
                error,
            )),
        }
    }

    fn read_key(&self, key: &Key) -> Result<Option<RawValue>> {
        let name = wide(self.value_name);
        // The value can change between sizing and fetching. Retry only that case, with a bound.
        for _ in 0..4 {
            let mut kind = 0;
            let mut size = 0;
            let result = unsafe {
                RegQueryValueExW(
                    key.0,
                    name.as_ptr(),
                    std::ptr::null(),
                    &mut kind,
                    std::ptr::null_mut(),
                    &mut size,
                )
            };
            if result == ERROR_FILE_NOT_FOUND {
                return Ok(None);
            }
            if result != ERROR_SUCCESS {
                return Err(registry_fault("autostart-read", "读取", result));
            }
            if size > MAX_VALUE_BYTES {
                return Err(Fault::new(
                    "autostart-read",
                    "自启动注册值超过 1 MiB，无法安全读取。",
                ));
            }
            let mut bytes = vec![0; size as usize];
            let result = unsafe {
                RegQueryValueExW(
                    key.0,
                    name.as_ptr(),
                    std::ptr::null(),
                    &mut kind,
                    bytes.as_mut_ptr(),
                    &mut size,
                )
            };
            match result {
                ERROR_SUCCESS => {
                    bytes.truncate(size as usize);
                    return Ok(Some(RawValue { kind, bytes }));
                }
                ERROR_FILE_NOT_FOUND => return Ok(None),
                ERROR_MORE_DATA => continue,
                error => return Err(registry_fault("autostart-read", "读取", error)),
            }
        }
        Err(changed_fault())
    }
}

impl Store for RegistryStore {
    fn read(&mut self) -> Result<Option<RawValue>> {
        match self.open(false, false)? {
            Some(key) => self.read_key(&key),
            None => Ok(None),
        }
    }

    fn replace(&mut self, expected: &Option<RawValue>, value: &Option<RawValue>) -> Result<()> {
        let key = self.open(true, value.is_some())?;
        let actual = match &key {
            Some(key) => self.read_key(key)?,
            None => None,
        };
        if actual != *expected {
            return Err(changed_fault());
        }
        let Some(key) = key else {
            return Ok(());
        };
        let name = wide(self.value_name);
        let result = unsafe {
            match value {
                Some(raw) => RegSetValueExW(
                    key.0,
                    name.as_ptr(),
                    0,
                    raw.kind,
                    raw.bytes.as_ptr(),
                    raw.bytes.len() as u32,
                ),
                None => RegDeleteValueW(key.0, name.as_ptr()),
            }
        };
        if result == ERROR_SUCCESS || (value.is_none() && result == ERROR_FILE_NOT_FOUND) {
            Ok(())
        } else {
            Err(registry_fault("autostart-write", "写入", result))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, sync::Arc};

    const EXE: &str = "C:\\工作台 空格\\shiye.exe";
    const OTHER: &str = "C:\\另一副本\\shiye.exe";

    #[derive(Default)]
    struct Memory {
        value: Option<RawValue>,
        reads: usize,
        writes: usize,
        read_errors: VecDeque<bool>,
        write_errors: VecDeque<bool>,
        before_write: Option<Option<RawValue>>,
        after_write: Option<Option<RawValue>>,
    }
    struct MemoryStore(Arc<Mutex<Memory>>);
    impl Store for MemoryStore {
        fn read(&mut self) -> Result<Option<RawValue>> {
            let mut memory = self.0.lock().unwrap();
            memory.reads += 1;
            if memory.read_errors.pop_front() == Some(true) {
                return Err(Fault::new("autostart-read", "测试读取失败"));
            }
            Ok(memory.value.clone())
        }
        fn replace(&mut self, expected: &Option<RawValue>, value: &Option<RawValue>) -> Result<()> {
            let mut memory = self.0.lock().unwrap();
            if let Some(external) = memory.before_write.take() {
                memory.value = external;
            }
            if memory.value != *expected {
                return Err(changed_fault());
            }
            memory.writes += 1;
            if memory.write_errors.pop_front() == Some(true) {
                return Err(Fault::new("autostart-write", "测试写入失败"));
            }
            memory.value = value.clone();
            if let Some(external) = memory.after_write.take() {
                memory.value = external;
            }
            Ok(())
        }
    }

    fn setup(value: Option<RawValue>) -> (Autostart, Arc<Mutex<Memory>>) {
        let memory = Arc::new(Mutex::new(Memory {
            value,
            ..Memory::default()
        }));
        (
            Autostart {
                store: Mutex::new(Box::new(MemoryStore(memory.clone()))),
                executable: Ok(EXE.into()),
                unavailable: None,
            },
            memory,
        )
    }
    fn change(autostart: &Autostart, enabled: bool) -> Change {
        Change {
            enabled,
            revision: autostart.status().revision.unwrap(),
        }
    }

    #[test]
    fn quotes_unicode_and_spaces_without_a_shell() {
        let value = command_value(EXE).unwrap();
        assert_eq!(value.kind, REG_SZ);
        assert_eq!(
            decode_string(&value).unwrap(),
            format!("\"{EXE}\" --autostart")
        );
        assert_eq!(command_target(&value).as_deref(), Some(EXE));
        assert_eq!(&value.bytes[value.bytes.len() - 2..], &[0, 0]);
        for invalid in ["relative.exe", "C:\\bad\"name.exe", "C:\\bad\0name.exe"] {
            assert_eq!(command_value(invalid).unwrap_err().code, "autostart-path");
        }
    }

    #[test]
    fn enforces_utf16_limit_including_quotes_and_arguments() {
        let overhead = "\"C:\\ .exe\" --autostart".encode_utf16().count() - 1;
        let exact = format!("C:\\{}.exe", "a".repeat(MAX_COMMAND_UNITS - overhead));
        assert_eq!(
            decode_string(&command_value(&exact).unwrap())
                .unwrap()
                .encode_utf16()
                .count(),
            260
        );
        let long = exact.replace(".exe", "x.exe");
        assert_eq!(command_value(&long).unwrap_err().code, "autostart-length");
        // Astral characters use two UTF-16 units despite being one Unicode scalar.
        let astral = exact.replacen("aa", "😀", 1);
        assert!(command_value(&astral).is_ok());
        let astral_long = exact.replacen('a', "😀", 1);
        assert_eq!(
            command_value(&astral_long).unwrap_err().code,
            "autostart-length"
        );
    }

    #[test]
    fn classifies_absent_current_other_and_unrecognized_values() {
        assert_eq!(snapshot_status(&None, EXE).state, "disabled");
        assert_eq!(
            snapshot_status(&Some(command_value(EXE).unwrap()), EXE).state,
            "enabled"
        );
        let status = snapshot_status(&Some(command_value(OTHER).unwrap()), EXE);
        assert_eq!(status.state, "other");
        assert_eq!(status.target.as_deref(), Some(OTHER));
        let malformed = RawValue {
            kind: 3,
            bytes: vec![0, 255, 42],
        };
        let status = snapshot_status(&Some(malformed), EXE);
        assert_eq!(status.state, "other");
        assert!(status.target.is_none());
        assert!(status.message.is_some());
    }

    #[test]
    fn ownership_matches_case_and_separators_but_rejects_extra_arguments() {
        let current = Some(command_value("c:/工作台 空格/SHIYE.EXE").unwrap());
        assert!(is_current(&current, EXE));
        let mut invalid = command_value(EXE).unwrap();
        invalid.bytes = format!("\"{EXE}\" --autostart --unrelated")
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert!(!is_current(&Some(invalid), EXE));
        assert!(!is_current(&Some(command_value(OTHER).unwrap()), EXE));
        let touching_argument = RawValue {
            kind: REG_SZ,
            bytes: format!("\"{EXE}\"--autostart")
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect(),
        };
        assert!(!is_current(&Some(touching_argument), EXE));
    }

    #[test]
    fn revision_includes_presence_type_and_exact_bytes() {
        let first = RawValue {
            kind: 1,
            bytes: vec![1, 2],
        };
        let second = RawValue {
            kind: 3,
            bytes: vec![1, 2],
        };
        assert_ne!(
            snapshot_revision(&Some(first.clone())),
            snapshot_revision(&Some(second))
        );
        assert_ne!(snapshot_revision(&None), snapshot_revision(&Some(first)));
    }

    #[test]
    fn enabling_writes_reads_back_then_saves() {
        let (autostart, memory) = setup(None);
        let change = change(&autostart, true);
        let saved = autostart
            .update(Some(&change), || {
                let memory = memory.lock().unwrap();
                assert_eq!(memory.value, Some(command_value(EXE).unwrap()));
                assert_eq!(memory.reads, 3); // Status, snapshot, readback.
                Ok(42)
            })
            .unwrap();
        assert_eq!(saved, 42);
        assert_eq!(autostart.status().state, "enabled");
    }

    #[test]
    fn closing_is_idempotent_and_does_not_delete_another_copy() {
        let (autostart, memory) = setup(Some(command_value(EXE).unwrap()));
        autostart
            .update(Some(&change(&autostart, false)), || Ok(()))
            .unwrap();
        autostart
            .update(Some(&change(&autostart, false)), || Ok(()))
            .unwrap();
        assert!(memory.lock().unwrap().value.is_none());
        assert_eq!(memory.lock().unwrap().writes, 1);
        let original = Some(command_value(OTHER).unwrap());
        let (autostart, memory) = setup(original.clone());
        autostart
            .update(Some(&change(&autostart, false)), || Ok(()))
            .unwrap();
        assert_eq!(memory.lock().unwrap().value, original);
        assert_eq!(memory.lock().unwrap().writes, 0);
    }

    #[test]
    fn saving_unrelated_settings_never_reads_or_writes_run() {
        let (mut autostart, memory) = setup(None);
        autostart.unavailable = Some("开发构建".into());
        memory.lock().unwrap().read_errors.push_back(true);
        assert_eq!(autostart.update(None, || Ok(7)).unwrap(), 7);
        assert_eq!(memory.lock().unwrap().reads, 0);
        assert_eq!(memory.lock().unwrap().writes, 0);
        assert_eq!(autostart.status().state, "unavailable");
        assert_eq!(memory.lock().unwrap().reads, 0);
    }

    #[test]
    fn unchanged_current_value_does_not_write() {
        let (autostart, memory) = setup(Some(command_value(EXE).unwrap()));
        autostart
            .update(Some(&change(&autostart, true)), || Ok(()))
            .unwrap();
        assert_eq!(memory.lock().unwrap().writes, 0);
    }

    #[test]
    fn overlong_current_path_preserves_existing_registration_and_skips_save() {
        let original = Some(command_value(OTHER).unwrap());
        let (mut autostart, memory) = setup(original.clone());
        autostart.executable = Ok(format!("C:\\{}.exe", "a".repeat(260)));
        let change = change(&autostart, true);
        let error = autostart
            .update::<()>(Some(&change), || panic!("overlong registration saved"))
            .unwrap_err();
        assert_eq!(error.code, "autostart-length");
        assert_eq!(memory.lock().unwrap().value, original);
        assert_eq!(memory.lock().unwrap().writes, 0);
    }

    #[test]
    fn unavailable_registration_and_path_errors_do_not_prevent_unrelated_saves() {
        let (mut autostart, memory) = setup(None);
        let change = Change {
            enabled: true,
            revision: snapshot_revision(&None),
        };
        autostart.unavailable = Some("隔离数据目录".into());
        assert_eq!(
            autostart
                .update::<()>(Some(&change), || panic!("unavailable registration saved"))
                .unwrap_err()
                .code,
            "autostart-unavailable"
        );
        autostart.unavailable = None;
        autostart.executable = Err(Fault::new("autostart-path", "无法确定程序路径"));
        assert_eq!(autostart.status().state, "error");
        assert_eq!(
            autostart
                .update::<()>(Some(&change), || panic!("invalid path saved"))
                .unwrap_err()
                .code,
            "autostart-path"
        );
        autostart.update(None, || Ok(())).unwrap();
        assert_eq!(memory.lock().unwrap().reads, 0);
        assert_eq!(memory.lock().unwrap().writes, 0);
    }

    #[test]
    fn stale_revision_preserves_external_changes_and_does_not_save() {
        let (autostart, memory) = setup(None);
        let change = change(&autostart, true);
        memory.lock().unwrap().value = Some(command_value(OTHER).unwrap());
        let error = autostart
            .update::<()>(Some(&change), || panic!("stale save ran"))
            .unwrap_err();
        assert_eq!(error.code, "autostart-conflict");
        assert_eq!(memory.lock().unwrap().writes, 0);
    }

    #[test]
    fn concurrent_external_change_at_write_is_not_overwritten_or_restored() {
        let (autostart, memory) = setup(None);
        let change = change(&autostart, true);
        let external = Some(command_value(OTHER).unwrap());
        memory.lock().unwrap().before_write = Some(external.clone());
        let error = autostart
            .update::<()>(Some(&change), || panic!("conflicting save ran"))
            .unwrap_err();
        assert_eq!(error.code, "autostart-conflict");
        assert_eq!(memory.lock().unwrap().value, external);
        assert_eq!(memory.lock().unwrap().writes, 0);
    }

    #[test]
    fn read_failure_is_unknown_and_prevents_registration_save() {
        let (autostart, memory) = setup(None);
        memory.lock().unwrap().read_errors.push_back(true);
        let status = autostart.status();
        assert_eq!(status.state, "error");
        assert!(status.revision.is_none());
        let change = Change {
            enabled: true,
            revision: snapshot_revision(&None),
        };
        memory.lock().unwrap().read_errors.push_back(true);
        let error = autostart
            .update::<()>(Some(&change), || panic!("unreadable save ran"))
            .unwrap_err();
        assert_eq!(error.code, "autostart-read");
        assert_eq!(memory.lock().unwrap().writes, 0);
    }

    #[test]
    fn write_failure_keeps_original_value_and_skips_local_save() {
        let original = Some(command_value(OTHER).unwrap());
        let (autostart, memory) = setup(original.clone());
        let change = change(&autostart, true);
        memory.lock().unwrap().write_errors.push_back(true);
        let error = autostart
            .update::<()>(Some(&change), || panic!("failed write saved"))
            .unwrap_err();
        assert_eq!(error.code, "autostart-write");
        assert_eq!(memory.lock().unwrap().value, original);
    }

    #[test]
    fn failed_readback_restores_original_before_returning_error() {
        let (autostart, memory) = setup(None);
        let change = change(&autostart, true);
        memory.lock().unwrap().read_errors.extend([false, true]);
        let error = autostart
            .update::<()>(Some(&change), || panic!("failed readback saved"))
            .unwrap_err();
        assert_eq!(error.code, "autostart-read");
        assert!(memory.lock().unwrap().value.is_none());
        assert_eq!(memory.lock().unwrap().writes, 2);
    }

    #[test]
    fn failed_local_save_restores_unfamiliar_type_and_bytes_exactly() {
        let original = Some(RawValue {
            kind: 3,
            bytes: vec![0, 255, 42, 0, 0, 7],
        });
        let (autostart, memory) = setup(original.clone());
        let change = change(&autostart, true);
        let error = autostart
            .update::<()>(Some(&change), || Err(Fault::new("config", "设置写入失败")))
            .unwrap_err();
        assert_eq!(error.code, "config");
        assert_eq!(memory.lock().unwrap().value, original);
        assert_eq!(memory.lock().unwrap().writes, 2);
    }

    #[test]
    fn failed_local_save_after_disabling_restores_original_registration() {
        let original = Some(command_value(EXE).unwrap());
        let (autostart, memory) = setup(original.clone());
        let change = change(&autostart, false);
        let error = autostart
            .update::<()>(Some(&change), || {
                assert!(memory.lock().unwrap().value.is_none());
                Err(Fault::new("config", "设置写入失败"))
            })
            .unwrap_err();
        assert_eq!(error.code, "config");
        assert_eq!(memory.lock().unwrap().value, original);
    }

    #[test]
    fn failed_restore_reports_partial_change_and_status_reads_actual_value() {
        let (autostart, memory) = setup(None);
        let change = change(&autostart, true);
        memory.lock().unwrap().write_errors.extend([false, true]);
        let error = autostart
            .update::<()>(Some(&change), || Err(Fault::new("config", "设置写入失败")))
            .unwrap_err();
        assert_eq!(error.code, "autostart-rollback");
        assert!(error.message.contains("部分变更"));
        assert!(error.message.contains("设置写入失败"));
        assert_eq!(autostart.status().state, "enabled");
    }

    #[test]
    fn readback_external_change_is_preserved_with_explicit_restore_failure() {
        let (autostart, memory) = setup(None);
        let change = change(&autostart, true);
        let external = Some(command_value(OTHER).unwrap());
        memory.lock().unwrap().after_write = Some(external.clone());
        let error = autostart
            .update::<()>(Some(&change), || panic!("mismatched readback saved"))
            .unwrap_err();
        assert_eq!(error.code, "autostart-rollback");
        assert_eq!(memory.lock().unwrap().value, external);
    }

    #[test]
    fn unsafe_identities_and_debug_runs_cannot_select_production_value() {
        assert_eq!(
            registration_policy(VALUE_NAME, false, false, false).unwrap(),
            VALUE_NAME
        );
        assert!(registration_policy(VALUE_NAME, true, false, false).is_err());
        assert!(registration_policy(VALUE_NAME, false, true, false).is_err());
        assert!(registration_policy(VALUE_NAME, false, false, true).is_err());
        assert!(registration_policy(QA_VALUE_NAME, false, true, false).is_err());
        assert!(registration_policy("arbitrary.value", false, false, true).is_err());
        assert!(registration_policy(QA_VALUE_NAME, true, true, true).is_err());
        assert_eq!(
            registration_policy(QA_VALUE_NAME, false, true, true).unwrap(),
            QA_VALUE_NAME
        );
    }

    #[test]
    fn concurrent_settings_saves_are_serialized_through_local_save() {
        use std::{sync::mpsc, time::Duration};
        let (autostart, _) = setup(None);
        let autostart = Arc::new(autostart);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let first = autostart.clone();
        let first_thread = std::thread::spawn(move || {
            first.update(None, || {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
        });
        entered_rx.recv().unwrap();
        let (second_tx, second_rx) = mpsc::channel();
        let second_thread = std::thread::spawn(move || {
            autostart.update(None, || {
                second_tx.send(()).unwrap();
                Ok(())
            })
        });
        assert!(second_rx.recv_timeout(Duration::from_millis(50)).is_err());
        release_tx.send(()).unwrap();
        first_thread.join().unwrap().unwrap();
        second_thread.join().unwrap().unwrap();
        second_rx.recv().unwrap();
    }
}
