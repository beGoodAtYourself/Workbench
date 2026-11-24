use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

#[derive(Debug, PartialEq, Eq)]
pub enum Launch {
    Background,
    Show(Vec<PathBuf>),
}

impl Launch {
    /// 两个入口的首个参数都是程序名；相对文件名以发起进程的工作目录为准。
    pub fn parse(arguments: impl IntoIterator<Item = impl AsRef<OsStr>>, cwd: &Path) -> Self {
        let mut paths = Vec::new();
        let mut positional = false;
        for argument in arguments.into_iter().skip(1) {
            let argument = argument.as_ref();
            if !positional && argument == "--autostart" {
                return Self::Background;
            }
            if !positional && argument == "--" {
                positional = true;
                continue;
            }
            if argument.is_empty() || (!positional && argument.as_encoded_bytes().starts_with(b"-"))
            {
                continue;
            }
            paths.push(cwd.join(argument));
        }
        Self::Show(paths)
    }
}

/// 文件由宿主保管，直到主窗口恢复完毕并切入文本编辑器。
#[derive(Default)]
pub struct PendingFiles {
    pub paths: Vec<PathBuf>,
    pub overflow: bool,
}

impl PendingFiles {
    pub fn activate(&mut self, launch: Launch) -> bool {
        const MAX_PENDING: usize = 12;
        let Launch::Show(paths) = launch else {
            return false;
        };
        let remaining = MAX_PENDING - self.paths.len();
        self.overflow |= paths.len() > remaining;
        self.paths.extend(paths.into_iter().take(remaining));
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_exact_startup_argument_requests_background_launch() {
        let cwd = Path::new(r"C:\测试");
        assert_eq!(
            Launch::parse(["拾页.exe", "--autostart"], cwd),
            Launch::Background
        );
        assert_eq!(
            Launch::parse(["拾页.exe", "--other", "--autostart"], cwd),
            Launch::Background
        );
        assert_eq!(Launch::parse(["拾页.exe"], cwd), Launch::Show(vec![]));
        assert_eq!(
            Launch::parse(["拾页.exe", "--autostart=false"], cwd),
            Launch::Show(vec![])
        );
        assert_eq!(Launch::parse(["--autostart"], cwd), Launch::Show(vec![]));
    }

    #[test]
    fn shell_arguments_keep_file_boundaries_and_the_launchers_directory() {
        let cwd = Path::new(r"D:\日志 目录");
        let absolute = r"C:\日志\2026-11-12.7464.IMGSDK.log";
        assert_eq!(
            Launch::parse(["拾页.exe", absolute, "相对 文件.log", "--", "-a.txt"], cwd),
            Launch::Show(vec![
                PathBuf::from(absolute),
                cwd.join("相对 文件.log"),
                cwd.join("-a.txt")
            ])
        );
    }

    #[test]
    fn launches_before_the_editor_is_ready_are_claimed_in_order_once() {
        let mut pending = PendingFiles::default();
        assert!(pending.activate(Launch::Show(vec!["a.log".into()])));
        assert!(!pending.activate(Launch::Background));
        assert!(pending.activate(Launch::Show(vec!["b.log".into(); 12])));
        let claimed = std::mem::take(&mut pending);
        assert_eq!(claimed.paths.len(), 12);
        assert_eq!(claimed.paths[0], Path::new("a.log"));
        assert_eq!(claimed.paths[1], Path::new("b.log"));
        assert!(claimed.overflow);
        assert!(pending.paths.is_empty());
        assert!(!pending.overflow);
    }
}
