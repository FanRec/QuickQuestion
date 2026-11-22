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
            .unwrap_or_else(std::env::temp_dir)
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
            // 窗口放在屏幕外时 Chromium 会判定为 occluded 并把页面置为 hidden，
            // DeepSeek 的虚拟列表随即不渲染任何消息 DOM，导致读不到回复。
            // 这三个参数让离屏窗口的页面保持可见与正常渲染（实测验证）。
            "--disable-backgrounding-occluded-windows".to_string(),
            "--disable-renderer-backgrounding".to_string(),
            "--disable-background-timer-throttling".to_string(),
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
        // 超时不能留下已 spawn 的进程：否则重试会累积孤儿、占用端口与 profile。
        self.shutdown();
        Err(AppError::msg("浏览器调试端口未在 30 秒内就绪，请检查是否被占用。"))
    }

    /// 应用退出时回收浏览器进程。take 出句柄，重复调用安全。
    pub fn shutdown(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// 兜底回收：任何路径（包括未走托盘退出的崩溃/窗口关闭）drop 时都尝试 kill。
/// 与显式 shutdown 幂等——shutdown 已 take 走句柄，这里拿到的是 None。
impl Drop for BrowserManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

async fn port_ready(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/json/version");
    match reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(client) => matches!(client.get(&url).send().await, Ok(resp) if resp.status().is_success()),
        Err(_) => false,
    }
}

/// 按优先级查找 Edge / Chrome 可执行文件：
/// Windows 看常规安装目录，macOS 找 App 包内二进制，Linux 沿 PATH 与常见目录探测。
fn find_browser() -> Option<std::path::PathBuf> {
    let candidates: Vec<std::path::PathBuf> = if cfg!(target_os = "windows") {
        let local = dirs::data_local_dir()?;
        let pf = std::env::var("ProgramFiles").unwrap_or_default();
        let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();
        let roots = [
            local,
            std::path::PathBuf::from(pf),
            std::path::PathBuf::from(pf86),
        ];
        let files = [
            "Microsoft/Edge/Application/msedge.exe",
            "Google/Chrome/Application/chrome.exe",
        ];
        roots
            .iter()
            .flat_map(|root| files.iter().map(move |f| root.join(f)))
            .collect()
    } else if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").unwrap_or_default();
        let roots = ["/Applications".to_string(), format!("{home}/Applications")];
        let apps = ["Microsoft Edge", "Google Chrome", "Chromium"];
        roots
            .iter()
            .flat_map(|root| {
                apps.iter().map(move |app| {
                    std::path::PathBuf::from(format!("{root}/{app}.app/Contents/MacOS/{app}"))
                })
            })
            .collect()
    } else {
        let names = [
            "microsoft-edge",
            "microsoft-edge-stable",
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
        ];
        let mut search_dirs: Vec<std::path::PathBuf> =
            std::env::split_paths(&std::env::var("PATH").unwrap_or_default()).collect();
        search_dirs.push(std::path::PathBuf::from("/usr/local/bin"));
        search_dirs.push(std::path::PathBuf::from("/snap/bin"));
        names
            .iter()
            .flat_map(|name| search_dirs.iter().map(move |dir| dir.join(name)))
            .collect()
    };
    candidates.into_iter().find(|p| p.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CDP 端点在本机回环地址上，系统代理环境下也必须能探活。
    /// 这条测试在 port_ready 不带 no_proxy() 时会失败：无效 HTTP_PROXY
    /// 会把探测请求劫走，假端点收不到请求，port_ready 返回 false。
    #[tokio::test]
    async fn port_ready_ignores_system_proxy() {
        // 起一个假的 CDP 端点，只回应一次探测。
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            use std::io::{Read, Write};
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 512];
                let _ = stream.read(&mut buf);
                let body = r#"{"Browser":"fake"}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });

        // 清掉可能干扰判定的代理变量，再设一个必然连不通的代理。
        let keys = [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
            "NO_PROXY",
            "no_proxy",
        ];
        let saved: Vec<(String, Option<String>)> = keys
            .iter()
            .map(|k| (k.to_string(), std::env::var(k).ok()))
            .collect();
        for k in keys {
            std::env::remove_var(k);
        }
        std::env::set_var("HTTP_PROXY", "http://127.0.0.1:1");

        let ready = port_ready(port).await;

        // 恢复环境；并主动唤醒 server 线程，避免修复前它一直阻塞在 accept。
        for (k, v) in saved {
            match v {
                Some(val) => std::env::set_var(&k, val),
                None => std::env::remove_var(&k),
            }
        }
        let _ = std::net::TcpStream::connect(("127.0.0.1", port));
        let _ = server.join();

        assert!(ready, "本机 CDP 端点不应被系统代理拦截");
    }
}
