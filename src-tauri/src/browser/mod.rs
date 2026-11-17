use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;

use crate::AppError;

pub const DEFAULT_PORT: u16 = 9222;
const DEEPSEEK_URL: &str = "https://chat.deepseek.com";

/// 管理专用 Edge/Chrome 进程。持有子进程句柄，应用退出时回收。
pub struct BrowserManager {
    child: Mutex<Option<Child>>,
    port: u16,
    profile_dir: std::path::PathBuf,
}

impl BrowserManager {
    pub fn new(port: u16) -> Self {
        let profile_dir = dirs::data_local_dir()
            .unwrap_or_else(|| std::env::temp_dir())
            .join("QuickQuestion")
            .join("browser-profile");
        Self {
            child: Mutex::new(None),
            port,
            profile_dir,
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// 确保调试端口上有可用浏览器；若端口已就绪则复用，否则启动新进程。
    pub async fn ensure_ready(&self) -> Result<(), AppError> {
        if port_ready(self.port).await {
            return Ok(());
        }
        self.start().await
    }

    async fn start(&self) -> Result<(), AppError> {
        let exe = find_browser()
            .ok_or_else(|| AppError::msg("未找到 Edge 或 Chrome，请先安装其中之一。"))?;

        std::fs::create_dir_all(&self.profile_dir)
            .map_err(|e| AppError::msg(format!("无法创建浏览器配置目录：{e}")))?;

        let profile = self.profile_dir.to_string_lossy();
        let args = [
            format!("--remote-debugging-port={}", self.port),
            "--remote-allow-origins=*".to_string(),
            format!("--user-data-dir={profile}"),
            "--no-first-run".to_string(),
            "--no-default-browser-check".to_string(),
            "--disable-blink-features=AutomationControlled".to_string(),
            "--lang=zh-CN".to_string(),
            "--window-position=-10000,-10000".to_string(),
            "--window-size=1200,900".to_string(),
            DEEPSEEK_URL.to_string(),
        ];

        let child = std::process::Command::new(&exe)
            .args(&args)
            .spawn()
            .map_err(|e| AppError::msg(format!("启动浏览器失败：{e}")))?;

        *self.child.lock().unwrap() = Some(child);

        // 等待调试端口就绪，最多 30 秒。
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while tokio::time::Instant::now() < deadline {
            if port_ready(self.port).await {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        Err(AppError::msg("浏览器调试端口未在 30 秒内就绪，请检查是否被占用。"))
    }

    /// 应用退出时回收浏览器进程。
    pub fn shutdown(&self) {
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

async fn port_ready(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/json/version");
    match reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(client) => matches!(client.get(&url).send().await, Ok(resp) if resp.status().is_success()),
        Err(_) => false,
    }
}

/// 按优先级查找 Edge / Chrome 可执行文件。
fn find_browser() -> Option<std::path::PathBuf> {
    let local = dirs::data_local_dir()?;
    let pf = std::env::var("ProgramFiles").unwrap_or_default();
    let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();
    let candidates = [
        local.join("Microsoft/Edge/Application/msedge.exe"),
        std::path::PathBuf::from(&pf).join("Microsoft/Edge/Application/msedge.exe"),
        std::path::PathBuf::from(&pf86).join("Microsoft/Edge/Application/msedge.exe"),
        local.join("Google/Chrome/Application/chrome.exe"),
        std::path::PathBuf::from(&pf).join("Google/Chrome/Application/chrome.exe"),
        std::path::PathBuf::from(&pf86).join("Google/Chrome/Application/chrome.exe"),
    ];
    candidates.into_iter().find(|p| p.exists())
}
