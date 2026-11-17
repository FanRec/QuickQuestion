//! CDP 内核集成测试。默认忽略（需真实浏览器），手动运行：
//!   cargo test --test cdp_kernel -- --ignored --nocapture

use std::time::Duration;

#[tokio::test]
#[ignore = "requires a real Edge/Chrome and network access to DeepSeek"]
async fn browser_connects_and_reads_deepseek_page() {
    let manager = quickquestion_lib::browser::BrowserManager::new(9222);
    manager
        .ensure_ready()
        .await
        .expect("浏览器应能启动或复用");

    let client = quickquestion_lib::cdp::CdpClient::connect(manager.port())
        .await
        .expect("应能连接 CDP");

    let href = client.current_url().await.expect("应能读取 URL");
    println!("page url: {href}");
    assert!(
        href.contains("chat.deepseek.com"),
        "页面应位于 chat.deepseek.com"
    );

    // 等待页面完成布局后再探测输入框。
    tokio::time::sleep(Duration::from_secs(3)).await;
    let input_ready = client.input_ready().await.expect("应能探测输入框");
    println!("input ready: {input_ready}");
}
