use crate::files::{Fault, Result, Workspace};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::{atomic::AtomicU64, Condvar, Mutex},
    time::Instant,
};
use tauri::Manager;
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneRecord {
    pub path: String,
    pub mode: String,
    pub cursor: u32,
    pub scroll: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Snapshot {
    pub module: String,
    pub panes: Vec<PaneRecord>,
    pub expanded: Vec<String>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            module: "notes".into(),
            panes: vec![],
            expanded: vec![],
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub root: Option<String>,
    pub shortcut: String,
    pub floating: bool,
    pub float_x: i32,
    pub float_y: i32,
    pub window: Option<[i32; 4]>,
    pub session: Snapshot,
    #[serde(skip_deserializing)]
    pub startup_error: Option<String>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            root: None,
            shortcut: "Control+Alt+Space".into(),
            floating: true,
            float_x: 40,
            float_y: 180,
            window: None,
            session: Snapshot::default(),
            startup_error: None,
        }
    }
}
pub struct AppState {
    pub settings: Mutex<Settings>,
    pub data: PathBuf,
    pub io: Mutex<()>,
    pub epoch: AtomicU64,
    pub idle: Mutex<Option<Instant>>,
    pub idle_changed: Condvar,
    pub wake: Mutex<Option<(Instant, bool)>>,
    pub profile: bool,
}
impl AppState {
    pub fn load(app: &tauri::AppHandle) -> Result<Self> {
        let data = std::env::var_os("SHIYE_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or(
                app.path()
                    .app_config_dir()
                    .map_err(|e| Fault::new("config", e.to_string()))?,
            );
        fs::create_dir_all(&data)?;
        let settings = match fs::read(data.join("settings.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| Settings {
                startup_error: Some("设置文件无法解析，已采用临时默认值。".into()),
                ..Settings::default()
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            settings: Mutex::new(settings),
            data,
            io: Mutex::new(()),
            epoch: AtomicU64::new(0),
            idle: Mutex::new(None),
            idle_changed: Condvar::new(),
            wake: Mutex::new(None),
            profile: std::env::var("SHIYE_PROFILE").as_deref() == Ok("1"),
        })
    }
    pub fn get(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }
    pub fn change(&self, update: impl FnOnce(&mut Settings)) -> Result<Settings> {
        let mut current = self.settings.lock().unwrap();
        let mut next = current.clone();
        update(&mut next);
        let mut temp = tempfile::Builder::new()
            .prefix(".shiye-config-")
            .tempfile_in(&self.data)?;
        temp.write_all(
            &serde_json::to_vec_pretty(&next).map_err(|e| Fault::new("config", e.to_string()))?,
        )?;
        temp.as_file().sync_all()?;
        temp.persist(self.data.join("settings.json"))
            .map_err(|e| Fault::from(e.error))?;
        *current = next.clone();
        Ok(next)
    }
    pub fn workspace(&self) -> Result<Workspace> {
        let root = self
            .get()
            .root
            .ok_or_else(|| Fault::new("workspace", "请先选择本地笔记文件夹。"))?;
        Workspace::new(std::path::Path::new(&root))
    }
}
