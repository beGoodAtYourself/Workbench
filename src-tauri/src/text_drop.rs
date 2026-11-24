//! 原生文件拖放的一次性授权；前端只能领取宿主收到的路径。
use crate::files::{Fault, Result};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct TextDrops {
    sequence: u64,
    pending: BTreeMap<String, (Instant, Vec<PathBuf>)>,
}

impl TextDrops {
    fn expire(&mut self) {
        self.pending
            .retain(|_, (created, _)| created.elapsed() < Duration::from_secs(60));
    }

    pub fn offer(&mut self, paths: Vec<PathBuf>) -> Result<String> {
        self.expire();
        if paths.is_empty() || paths.len() > 12 {
            return Err(Fault::new("text-tabs", "每次请拖入 1 至 12 个文本文件。"));
        }
        if self.pending.len() >= 4 {
            return Err(Fault::new("busy", "正在处理拖入的文件，请稍后重试。"));
        }
        self.sequence += 1;
        let token = format!("drop-{}", self.sequence);
        self.pending.insert(token.clone(), (Instant::now(), paths));
        Ok(token)
    }

    pub fn take(&mut self, token: &str) -> Result<Vec<PathBuf>> {
        self.expire();
        self.pending
            .remove(token)
            .map(|(_, paths)| paths)
            .ok_or_else(|| Fault::new("authorization", "文件拖放已过期或已处理，请重新拖入。"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_host_offered_paths_can_be_claimed_once() {
        let mut drops = TextDrops::default();
        let paths = vec![PathBuf::from(r"C:\测试\a.log")];
        assert!(drops.take("drop-1").is_err());
        let token = drops.offer(paths.clone()).unwrap();
        assert_eq!(drops.take(&token).unwrap(), paths);
        assert!(drops.take(&token).is_err());
    }

    #[test]
    fn pending_drops_are_bounded_and_expire() {
        let mut drops = TextDrops::default();
        assert!(drops.offer(vec![]).is_err());
        assert!(drops.offer(vec![PathBuf::from("a"); 13]).is_err());
        for _ in 0..4 {
            drops.offer(vec![PathBuf::from("a")]).unwrap();
        }
        assert!(drops.offer(vec![PathBuf::from("a")]).is_err());
        drops.pending.get_mut("drop-1").unwrap().0 = Instant::now() - Duration::from_secs(61);
        assert!(drops.take("drop-1").is_err());
        assert!(drops.offer(vec![PathBuf::from("b")]).is_ok());
    }
}
