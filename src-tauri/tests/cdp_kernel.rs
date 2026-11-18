//! CDP 内核集成测试。默认忽略（需真实浏览器 + 已登录 DeepSeek），手动运行：
//!   cargo test --test cdp_kernel -- --ignored --nocapture

use std::sync::Arc;
use std::time::Duration;

use quickquestion_lib::cdp::StreamEvent;

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
    assert!(input_ready, "已登录时输入框应可见");
}

/// 端到端流式测试：发一条简单问题，确认收到 delta 与 done 事件。
#[tokio::test]
#[ignore = "requires a logged-in DeepSeek session and network access"]
async fn send_message_streams_delta_then_done() {
    let manager = quickquestion_lib::browser::BrowserManager::new(9222);
    manager.ensure_ready().await.expect("浏览器应就绪");
    let client = Arc::new(
        quickquestion_lib::cdp::CdpClient::connect(manager.port())
            .await
            .expect("应能连接 CDP"),
    );

    let mut rx = client.subscribe().await;
    client.reset_cancel();
    let before = client
        .send_message("请只回复两个字：收到", &[])
        .await
        .expect("应能发送消息");
    // Rust 侧轮询任务推送 delta/done 到同一通道。
    client.clone().spawn_reply_poller(before, 900);

    let mut delta_count = 0;
    let mut final_text = String::new();
    let mut done = false;
    // 最多等待 90 秒。
    let wait = tokio::time::timeout(Duration::from_secs(90), async {
        while let Some(event) = rx.recv().await {
            match event {
                StreamEvent::Delta { text } => {
                    delta_count += 1;
                    final_text = text;
                }
                StreamEvent::Done { text } => {
                    final_text = text;
                    done = true;
                    break;
                }
                StreamEvent::Error { message } => {
                    panic!("流式错误：{message}");
                }
            }
        }
    })
    .await;

    assert!(wait.is_ok(), "流式回复不应超过 90 秒");
    println!("delta 次数: {delta_count}, 最终文本: {final_text}");
    assert!(delta_count >= 1, "应至少收到一次增量");
    assert!(done, "应收到完成事件");
    assert!(!final_text.trim().is_empty(), "最终文本不应为空");
}
