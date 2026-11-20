use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::cdp::StreamEvent;
use crate::error::AppError;
use crate::model::{BrowserStatus, Exchange, Session};
use crate::store::to_markdown;
use crate::AppState;

/// 健康检查命令；M0 用于验证 IPC 链路。
#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}

/// 确保浏览器与 CDP 就绪，返回可展示的连接状态。
#[tauri::command]
pub async fn browser_status(state: State<'_, Arc<AppState>>) -> Result<BrowserStatus, AppError> {
    let cdp = state.ensure_cdp().await?;
    let page_url = cdp.current_url().await.unwrap_or_default();
    let input_ready = cdp.input_ready().await.unwrap_or(false);
    let (needs_login, login_reason, _, _) = cdp
        .login_state()
        .await
        .unwrap_or((false, String::new(), String::new(), false));
    Ok(BrowserStatus {
        ready: true,
        port: state.browser.port(),
        page_url,
        input_ready,
        needs_login,
        login_reason,
    })
}

/// 发送结果：前端据此定位到本轮问答所属的本地会话。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub exchange_id: String,
    pub session_id: String,
}

/// 发送消息。立即返回所属会话与 exchangeId；后续增量经 `qq://stream` 推送。
///
/// 会话编排全部在这里完成，前端只表达意图（sessionId + newSession）：
/// - newSession=true：网页开全新会话，本地也新建会话
/// - newSession=false 且 sessionId 有绑定：网页切到该会话，接续上下文
/// - newSession=false 且无绑定/无 sessionId：新建会话 + 网页首页
// 参数即 IPC 契约（与前端 sendMessage 的字段一一对应），收拢成结构体要两端同改，不值。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    text: String,
    files: Vec<String>,
    deep_think: bool,
    web_search: bool,
    session_id: String,
    inject_prompt: bool,
    new_session: bool,
) -> Result<SendResult, AppError> {
    // 抢发送权：失败要立刻明确返回，前端才能提示"正在回复中"而不是静默卡住。
    if !state.try_begin_send() {
        return Err(AppError::msg("正在回复中，请等待完成或先打断。".to_string()));
    }
    // 从这一刻起发送权由 guard 持有：任何失败/提前返回都自动释放，
    // 成功路径则把 guard 交给事件消费任务，到终态再释放。
    let guard = crate::SendGuard::new(state.inner().clone());

    send_inner(
        &app,
        &state,
        guard,
        text,
        files,
        deep_think,
        web_search,
        session_id,
        inject_prompt,
        new_session,
    )
    .await
}

/// 实际发送流程。发送权由 guard 持有；成功时 guard 移交给事件消费任务，到终态释放。
#[allow(clippy::too_many_arguments)]
async fn send_inner(
    app: &AppHandle,
    state: &Arc<AppState>,
    mut guard: crate::SendGuard,
    text: String,
    files: Vec<String>,
    deep_think: bool,
    web_search: bool,
    session_id: String,
    inject_prompt: bool,
    new_session: bool,
) -> Result<SendResult, AppError> {
    let cdp = state.ensure_cdp().await?;
    // 设置整轮只读一次：quiet_ms / system_prompt / last_session_id 同源，
    // 避免发送过程中多次读盘拿到不一致的快照。
    let settings = state.config.load();

    // 会话决策：new_session 或没有可用绑定时，都新建本地会话。
    let existing = if new_session {
        None
    } else {
        state.store.find_session(&session_id)?
    };
    // Some(会话id) 表示本轮新建了会话；发送失败要回滚，避免留下空会话。
    let mut new_session_id: Option<String> = None;
    let chosen = if let Some(s) = existing.filter(|s| !s.deepseek_chat_id.is_empty()) {
        // 只有已绑定网页会话的本地会话才能接续；否则继续走新建分支，
        // 避免把两个不同网页会话的问答混进同一个本地会话。
        s
    } else {
        let s = state.store.create_session("新会话")?;
        new_session_id = Some(s.id.clone());
        s
    };

    let id = Uuid::new_v4().to_string();
    let exchange_id = id.clone();
    let quiet_ms = settings.quiet_ms;

    // 会话首条问答才注入长期设定；新建的会话总是首条。
    let outgoing = if inject_prompt && !settings.system_prompt.trim().is_empty() {
        format!(
            "[长期设定]\n{}\n[/长期设定]\n\n{}",
            settings.system_prompt.trim(),
            text
        )
    } else {
        text.clone()
    };

    // 网页切换到发送这一段的任何失败都不能留下空会话。
    let sent = async {
        // 网页切到目标会话：有绑定则接续，否则开全新对话。
        if chosen.deepseek_chat_id.is_empty() {
            cdp.new_conversation().await?;
        } else {
            cdp.navigate_to_chat(&chosen.deepseek_chat_id).await?;
        }

        // 模式开关必须在导航之后同步——导航会重建 DOM，之前点的开关状态会丢。
        cdp.apply_modes(deep_think, web_search).await?;
        // 先订阅再发送，避免事件在订阅之前到达而丢失。
        let rx = cdp.subscribe().await;
        cdp.reset_cancel();
        cdp.send_message(&outgoing, &files).await?;
        Ok(rx)
    }
    .await;

    let mut rx = match sent {
        Ok(rx) => rx,
        Err(e) => {
            // 网页切换/发送失败：回滚刚建的空会话。guard 随 return 自动释放发送权。
            if let Some(sid) = &new_session_id {
                let _ = state.store.delete_session(sid);
            }
            return Err(e);
        }
    };

    // 发送成功才把新会话设为启动恢复点；失败时不覆盖用户原有的恢复点。
    // 记住旧恢复点：回复阶段失败（超时/取消/登录失效）时要还原，避免下次启动进空会话。
    let old_last_session = settings.last_session_id.clone();
    if let Some(sid) = &new_session_id {
        state.config.set_last_session(sid)?;
    }

    let app_for_task = app.clone();
    let state_for_task = state.clone();
    let cdp_for_task = cdp.clone();
    cdp.clone().spawn_reply_poller(quiet_ms);
    let question_text = text.clone();
    let session_for_task = chosen.id.clone();
    let image_names = files
        .iter()
        .map(std::path::Path::new)
        .filter_map(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    // 失败收口所需的信息随任务移动：新建会话 id 与旧恢复点。
    let rollback_session = new_session_id.clone();
    let config_for_task = state.config.clone();
    tauri::async_runtime::spawn(async move {
        // guard 随任务持有发送权；任何退出路径（含 panic 前的 drop）都释放。
        while let Some(event) = rx.recv().await {
            match event {
                StreamEvent::Delta { text } => {
                    let _ = app_for_task.emit(
                        "qq://stream",
                        serde_json::json!({
                            "type": "delta",
                            "exchangeId": exchange_id,
                            "text": text,
                        }),
                    );
                }
                StreamEvent::Done { text } => {
                    let answer = text;
                    let created_at = crate::store::now_ms();
                    // done 时抓网页 chat_id；未切稳则为空，绑定留待下次不覆盖。
                    let chat_id = cdp_for_task.current_chat_id().await.unwrap_or_default();
                    // 落库 + 更新会话 + 绑定在同一事务；失败绝不发 done，
                    // 否则前端以为完成、刷新后记录消失（error 与 done 语义冲突）。
                    let stored = state_for_task.store.commit_exchange(
                        &Exchange {
                            id: exchange_id.clone(),
                            session_id: session_for_task.clone(),
                            created_at,
                            question_text: question_text.clone(),
                            answer_text: answer.clone(),
                            image_names: image_names.clone(),
                        },
                        &chat_id,
                    );
                    if let Err(e) = stored {
                        let _ = app_for_task.emit(
                            "qq://stream",
                            serde_json::json!({
                                "type": "error",
                                "exchangeId": exchange_id,
                                "message": format!("保存历史失败：{}", e.message),
                            }),
                        );
                        // 落库失败也要回滚刚建的空会话与恢复点。
                        if let Some(sid) = &rollback_session {
                            let _ = state_for_task.store.delete_session(sid);
                            let _ = config_for_task.set_last_session(&old_last_session);
                        }
                        cdp_for_task.unsubscribe().await;
                        break;
                    }
                    // 事件自带标题：前端直接用它更新接续显示，不再回拉 active_session。
                    // 回拉在 done 时刻可能读到还没切稳的网页 URL，空结果会把权威的
                    // sessionId 覆盖成空串（接续行消失、下次发送误判为新会话）。
                    let active_title = state_for_task
                        .store
                        .find_session(&session_for_task)
                        .ok()
                        .flatten()
                        .map(|s| s.title)
                        .unwrap_or_default();
                    let _ = app_for_task.emit(
                        "qq://active",
                        serde_json::json!({
                            "sessionId": session_for_task,
                            "chatId": chat_id,
                            "title": active_title,
                        }),
                    );
                    let _ = app_for_task.emit(
                        "qq://stream",
                        serde_json::json!({
                            "type": "done",
                            "exchangeId": exchange_id,
                            "text": answer,
                        }),
                    );
                    cdp_for_task.unsubscribe().await;
                    break;
                }
                StreamEvent::Error { message, kind } => {
                    // 回复阶段失败：没有 exchange 落库，回滚空会话与恢复点，
                    // 否则下次启动恢复到空会话、且该会话看似可接续实则无内容。
                    if let Some(sid) = &rollback_session {
                        let has_any = state_for_task
                            .store
                            .list_by_session(sid)
                            .map(|v| !v.is_empty())
                            .unwrap_or(false);
                        if !has_any {
                            let _ = state_for_task.store.delete_session(sid);
                            let _ = config_for_task.set_last_session(&old_last_session);
                        }
                    }
                    let mut payload = serde_json::json!({
                        "type": "error",
                        "exchangeId": exchange_id,
                        "message": message,
                    });
                    if let Some(kind) = kind {
                        payload["kind"] = serde_json::json!(kind);
                    }
                    let _ = app_for_task.emit("qq://stream", payload);
                    cdp_for_task.unsubscribe().await;
                    break;
                }
            }
        }
        guard.release();
    });

    Ok(SendResult {
        exchange_id: id,
        session_id: chosen.id,
    })
}

/// 取消当前问答的接收。
/// 只置取消标志；"已取消"事件由轮询任务统一发出，避免同一事件双源广播。
#[tauri::command]
pub async fn cancel_message(state: State<'_, Arc<AppState>>) -> Result<(), AppError> {
    if let Some(cdp) = state.cdp.lock().await.as_ref() {
        cdp.cancel_current();
    }
    Ok(())
}

/// 列出全部问答（倒序），悬浮列表与主窗口左栏共用。
#[tauri::command]
pub fn list_exchanges(
    state: State<'_, Arc<AppState>>,
    session_id: Option<String>,
) -> Result<Vec<Exchange>, AppError> {
    match session_id {
        // 指定会话就只看该会话的问答；不传则返回全部（悬浮面板的历史用）。
        Some(id) if !id.is_empty() => state.store.list_by_session(&id),
        _ => state.store.list(),
    }
}

/// 列出全部会话，按最近活动排序。
#[tauri::command]
pub fn list_sessions(state: State<'_, Arc<AppState>>) -> Result<Vec<Session>, AppError> {
    state.store.list_sessions()
}

/// 新建本地会话。网页端的会话切换统一由 send_message 编排，
/// 这里不碰网页——否则会出现"本地建了、网页没切"的错位。
#[tauri::command]
pub fn create_session(
    state: State<'_, Arc<AppState>>,
    title: Option<String>,
) -> Result<Session, AppError> {
    state.store.create_session(title.as_deref().unwrap_or("新会话"))
}

/// 是否正在回复中。悬浮球据此决定要不要让位给独立输入条。
#[tauri::command]
pub fn is_sending(state: State<'_, Arc<AppState>>) -> bool {
    state
        .sending
        .load(std::sync::atomic::Ordering::SeqCst)
}

/// 当前网页会话：chatId 来自 URL，本地会话由绑定反查。
/// 前端据此显示活跃标记；冷启动时也可用来校正选中项。
#[tauri::command]
pub async fn active_session(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<Session>, AppError> {
    let cdp = match state.cdp.lock().await.as_ref() {
        Some(cdp) => cdp.clone(),
        None => return Ok(None),
    };
    let chat_id = cdp.current_chat_id().await.unwrap_or_default();
    state.store.find_by_chat_id(&chat_id)
}

/// 记住当前选中的会话，供下次启动恢复。
#[tauri::command]
pub fn remember_session(state: State<'_, Arc<AppState>>, id: String) -> Result<(), AppError> {
    state.config.set_last_session(&id)
}

/// 删除会话及其全部问答。
#[tauri::command]
pub fn delete_session(state: State<'_, Arc<AppState>>, id: String) -> Result<(), AppError> {
    state.store.delete_session(&id)
}

/// 获取单条问答详情。
#[tauri::command]
pub fn get_exchange(state: State<'_, Arc<AppState>>, id: String) -> Result<Option<Exchange>, AppError> {
    state.store.get(&id)
}

/// 删除一条问答。
#[tauri::command]
pub fn delete_exchange(state: State<'_, Arc<AppState>>, id: String) -> Result<(), AppError> {
    state.store.delete(&id)
}

/// 生成复制文本：`## 问题\n回复`；剪贴板写入由前端完成。
#[tauri::command]
pub fn copy_markdown(state: State<'_, Arc<AppState>>, id: String) -> Result<String, AppError> {
    let exchange = state
        .store
        .get(&id)?
        .ok_or_else(|| AppError::msg("未找到该问答。"))?;
    Ok(to_markdown(&exchange))
}

/// 打开登录流程：把浏览器窗口移到屏幕中央供用户完成登录。
#[tauri::command]
pub async fn open_login_window(state: State<'_, Arc<AppState>>) -> Result<(), AppError> {
    let cdp = state.ensure_cdp().await?;
    cdp.show_browser_window().await
}

/// 把粘贴进来的图片字节落盘，返回路径供 CDP 上传使用。
/// 放在应用数据目录而非系统 Temp，方便用户自行清理。
#[tauri::command]
pub fn save_temp_image(bytes: Vec<u8>, ext: String) -> Result<String, AppError> {
    if bytes.is_empty() {
        return Err(AppError::msg("粘贴的内容为空。"));
    }
    let ext = ext
        .to_ascii_lowercase()
        .replace(|c: char| !c.is_ascii_alphanumeric(), "");
    let ext = if ext.is_empty() { "png".to_string() } else { ext };
    let dir = dirs::data_local_dir()
        .ok_or_else(|| AppError::msg("无法定位应用数据目录。".to_string()))?
        .join("QuickQuestion")
        .join("pasted");
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::msg(format!("创建粘贴目录失败：{e}")))?;
    let path = dir.join(format!("paste-{}.{ext}", Uuid::new_v4()));
    std::fs::write(&path, bytes).map_err(|e| AppError::msg(format!("写入粘贴图片失败：{e}")))?;
    Ok(path.to_string_lossy().to_string())
}

/// 读取设置。
#[tauri::command]
pub fn get_settings(state: State<'_, Arc<AppState>>) -> crate::config::Settings {
    state.config.load()
}

/// 更新设置（端口改动需重启应用生效）。
///
/// 只接受用户可编辑的白名单字段：last_session_id 的单一写权在后端
/// （remember_session / 发送成功后），前端传来的任何快照都不得覆盖它。
/// 设置页挂载时读一次快照，期间若悬浮球发送或主窗口切会话改了恢复点，
/// 保存时旧快照会把恢复点冲回旧会话——这里从后端根治。
#[tauri::command]
pub fn update_settings(
    state: State<'_, Arc<AppState>>,
    settings: crate::config::Settings,
) -> Result<(), AppError> {
    let mut current = state.config.load();
    current.browser_port = settings.browser_port;
    current.quiet_ms = settings.quiet_ms;
    current.system_prompt = settings.system_prompt;
    current.hotkey = settings.hotkey;
    current.bubble_hide_secs = settings.bubble_hide_secs;
    current.popup_hide_secs = settings.popup_hide_secs;
    // current.last_session_id 保持不变：它是后端专属的恢复点。
    state.config.save(&current)
}
