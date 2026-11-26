use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::card_presets::PresetInfo;
use crate::cdp::StreamEvent;
use crate::error::AppError;
use crate::model::{BrowserStatus, Exchange, Session};
use crate::store::to_markdown;
use crate::AppState;

/// 前端隐藏悬浮球（右键菜单 / Alt+F4）时统一走后端，
/// 保证托盘文案与窗口实际可见性一致。
#[tauri::command]
pub fn set_panel_visible(app: AppHandle, visible: bool) {
    crate::tray::set_panel_visible(&app, visible);
}

/// 确保浏览器与 CDP 就绪，返回可展示的连接状态。
#[tauri::command]
pub async fn browser_status(state: State<'_, Arc<AppState>>) -> Result<BrowserStatus, AppError> {
    let cdp = state.ensure_cdp().await?;
    // login_state 已一次返回四项：复用它，避免 current_url + input_ready 两次额外 CDP 往返。
    let (needs_login, login_reason, page_url, input_ready) = cdp
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
    new_session: bool,
) -> Result<SendResult, AppError> {
    let cdp = state.ensure_cdp().await?;
    // 取消标志必须在发送准备期的等待之前重置：原先在 subscribe 之后才 reset，
    // 用户在导航/开关同步期间点「打断」置位的 cancelled 会被吞掉，导致回复照常
    // 落库、前端却已退出 stream 态而全程丢弃事件。冷启动连接期 cancel 本就拿不到
    // cdp，无需覆盖；此处重置后，后续所有准备期等待中的取消都能生效。
    cdp.reset_cancel();
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

    // 是否注入长期设定由后端权威判定，不再依赖前端传来的标志：
    // 前端两个入口（悬浮球/主窗口）判定逻辑不同，且悬浮球看不到会话问答数，必然猜错。
    // 权威依据：本轮新建的会话一定是首条；已绑定的会话若本地一条问答都没有也是首条。
    let is_first = new_session_id.is_some()
        || state
            .store
            .list_by_session(&chosen.id)
            .map(|v| v.is_empty())
            .unwrap_or(false);
    let outgoing = if is_first && !settings.system_prompt.trim().is_empty() {
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
        // 网页切到目标会话：已在目标则跳过导航，避免连续追问整页重载。
        let current_chat_id = cdp.current_chat_id().await.unwrap_or_default();
        if needs_navigate(&current_chat_id, &chosen.deepseek_chat_id) {
            if chosen.deepseek_chat_id.is_empty() {
                cdp.new_conversation().await?;
            } else {
                cdp.navigate_to_chat(&chosen.deepseek_chat_id).await?;
            }
        }

        // 模式开关必须在导航之后同步——导航会重建 DOM，之前点的开关状态会丢。
        cdp.apply_modes(deep_think, web_search).await?;
        // 先订阅再发送，避免事件在订阅之前到达而丢失。
        let rx = cdp.subscribe().await;
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
        // 写恢复点失败不能中断本轮：消息此时已经在网页上了，返回 Err 只会让前端
        // 退出流态、把已经收到的回答丢在网页端，本地还留下一个空会话。
        // 退化为日志——接续记录仍会随 done 落库，只是下次启动少一次自动恢复。
        if let Err(e) = state.config.set_last_session(sid) {
            eprintln!("保存启动恢复点失败：{e}");
        }
    }

    let app_for_task = app.clone();
    let state_for_task = state.clone();
    let cdp_for_task = cdp.clone();
    // 先广播本轮 id，再启动轮询。前端 streamingRef 已在 submit 同步置位，
    // 因此即使 delta 比 send_message 的 IPC 返回更早到达，也能认领这一轮。
    // 没有这条 start，早到事件会被 pendingExchangeIdRef=null 吞掉，气泡永久停在思考中。
    let _ = app.emit(
        "qq://stream",
        serde_json::json!({ "type": "start", "exchangeId": exchange_id }),
    );
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
    // 接续会话已知 chat_id，无需在 done 时刻再抓 URL（可能还没切稳）。
    // 新会话若此刻仍为空，记录"待补绑"，落库后在后台继续等 URL 切稳。
    let known_chat_id = chosen.deepseek_chat_id.clone();
    let need_bind_backfill = known_chat_id.is_empty();
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
                    // 接续会话沿用已知 chat_id；新建会话则等 URL 切稳（最多 5s），
                    // 避免 done 早于 SPA 导航导致绑定失败、下次无法接续。
                    let chat_id = if known_chat_id.is_empty() {
                        cdp_for_task
                            .current_chat_id_wait(std::time::Duration::from_secs(5))
                            .await
                    } else {
                        known_chat_id.clone()
                    };
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
                            // 仅当恢复点仍指向本轮会话（期间没被用户切换）才回滚。
                            let _ = config_for_task.restore_last_session_if(sid, &old_last_session);
                        }
                        // 这条路径没有走 finish（错误直接 emit 给前端），订阅者仍是本轮
                        // 安装的那个，必须自己摘掉——否则下一轮 subscribe 前的残留窗口里
                        // 页面事件会继续流向已结束的轮次。
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

                    // 新会话首条：done 时 URL 可能还没切到 /a/chat/s/{uuid}，
                    // 此时 chat_id 为空、会话落库但未绑定，下次发送会另起新会话。
                    // 回复已交付用户，这里在后台有界地再等一次 URL：拿到就补绑，
                    // 使该会话重新具备接续能力。若期间网页已切到另一个已绑定会话
                    // （find_by_chat_id 命中别的本地会话），放弃补绑，避免串会话。
                    if need_bind_backfill && chat_id.is_empty() {
                        let bg_app = app_for_task.clone();
                        let bg_state = state_for_task.clone();
                        let bg_cdp = cdp_for_task.clone();
                        let bg_session = session_for_task.clone();
                        tauri::async_runtime::spawn(async move {
                            let late = bg_cdp
                                .current_chat_id_wait(std::time::Duration::from_secs(20))
                                .await;
                            if late.is_empty() {
                                return;
                            }
                            if matches!(
                                bg_state.store.find_by_chat_id(&late),
                                Ok(Some(other)) if other.id != bg_session
                            ) {
                                return;
                            }
                            match bg_state.store.bind_chat_id(&bg_session, &late) {
                                Ok(true) => {
                                    let title = bg_state
                                        .store
                                        .find_session(&bg_session)
                                        .ok()
                                        .flatten()
                                        .map(|s| s.title)
                                        .unwrap_or_default();
                                    let _ = bg_app.emit(
                                        "qq://active",
                                        serde_json::json!({
                                            "sessionId": bg_session,
                                            "title": title,
                                        }),
                                    );
                                }
                                Ok(false) => {}
                                Err(e) => eprintln!("补绑网页会话失败：{e}"),
                            }
                        });
                    }
                    // 不再 unsubscribe：finish 已把订阅者 take 走。此时再清一次要么空转，
                    // 要么清掉下一轮刚安装的订阅者（用户收到 done 后立刻追问的窗口）。
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
                            // CAS：用户期间切到别的会话则不覆盖其选择。
                            let _ = config_for_task.restore_last_session_if(sid, &old_last_session);
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
                    // 同 Done 分支：finish 已摘除订阅者，这里不再重复清。
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

/// 列出全部问答（倒序）。悬浮列表、主窗口左栏与贴图入口共用这一份数据；
/// 按会话筛选由前端从全集派生（bySession），IPC 不再保留无人使用的过滤参数。
#[tauri::command]
pub fn list_exchanges(state: State<'_, Arc<AppState>>) -> Result<Vec<Exchange>, AppError> {
    state.store.list()
}

/// 列出全部会话，按最近活动排序。
#[tauri::command]
pub fn list_sessions(state: State<'_, Arc<AppState>>) -> Result<Vec<Session>, AppError> {
    state.store.list_sessions()
}

/// 是否正在回复中。悬浮球据此决定要不要让位给独立输入条。
#[tauri::command]
pub fn is_sending(state: State<'_, Arc<AppState>>) -> bool {
    state
        .sending
        .load(std::sync::atomic::Ordering::SeqCst)
}

/// 当前网页会话：chatId 来自 URL，本地会话由绑定反查。
/// 冷启动时浏览器尚未连接、或网页停在首页没有 chat_id——此时回退到持久化的
/// last_session_id（启动恢复点）。否则悬浮球的 refreshActive 恒拿到 None，
/// 接续显示永远是"未接续"，即使上次明明聊过。
#[tauri::command]
pub async fn active_session(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<Session>, AppError> {
    let chat_id = match state.cdp.lock().await.as_ref() {
        Some(cdp) => cdp.current_chat_id().await.unwrap_or_default(),
        None => String::new(),
    };
    // 网页 URL 是运行时真相源；命中就用它。
    if !chat_id.is_empty() {
        if let Some(s) = state.store.find_by_chat_id(&chat_id)? {
            return Ok(Some(s));
        }
    }
    // 冷启动回退：网页还没连上或停在首页时，用启动恢复点。
    let last = state.config.load().last_session_id;
    if last.is_empty() {
        return Ok(None);
    }
    state.store.find_session(&last)
}

/// 记住当前选中的会话，供下次启动恢复。
#[tauri::command]
pub fn remember_session(state: State<'_, Arc<AppState>>, id: String) -> Result<(), AppError> {
    state.config.set_last_session(&id)
}

/// 真正切换会话：把网页导航到该会话，再广播活跃会话。
///
/// 与左栏单击的区别必须显式：单击是浏览焦点（currentId），不驱动网页——翻看
/// 历史时每次整页重载既慢又没必要。菜单里的「切换到该会话」是显式命令，网页
/// 必须跟过去，否则接续行、网页位置标记与悬浮球的发送目标都停在旧会话。
#[tauri::command]
pub async fn switch_session(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<Session, AppError> {
    // 回复进行中不能切：导航会重建 DOM，正在轮询的回复直接丢失。
    if state.sending.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(AppError::msg("正在回复中，请等待完成或先打断。".to_string()));
    }
    let session = state
        .store
        .find_session(&id)?
        .ok_or_else(|| AppError::msg("未找到该会话。".to_string()))?;
    if session.deepseek_chat_id.is_empty() {
        return Err(AppError::msg("该会话尚未绑定网页会话，无法接续。".to_string()));
    }
    let cdp = state.ensure_cdp().await?;
    // 已在目标会话就不重复导航：导航本身要等输入框就绪，能省则省。
    let current_chat_id = cdp.current_chat_id().await.unwrap_or_default();
    if needs_navigate(&current_chat_id, &session.deepseek_chat_id) {
        cdp.navigate_to_chat(&session.deepseek_chat_id).await?;
    }
    // 广播而非让各窗口自己回拉：此刻 URL 已切稳，事件里的会话是权威值。
    let _ = app.emit(
        "qq://active",
        serde_json::json!({ "sessionId": session.id, "title": session.title }),
    );
    Ok(session)
}

/// 删除会话及其全部问答。
#[tauri::command]
pub fn delete_session(state: State<'_, Arc<AppState>>, id: String) -> Result<(), AppError> {
    state.store.delete_session(&id)
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

/// 粘贴图片只用于本轮上传，落库后不再被读取。给个有界 TTL，
/// 每次粘贴前顺手清一次陈年文件，避免应用数据目录无限增长。
const PASTED_IMAGE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

fn cleanup_old_pasted(dir: &Path, now: SystemTime, ttl: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        // 文件写入后不再改动，modified 就是生成时间；比 created 跨平台可靠。
        let Ok(stamp) = meta.modified() else {
            continue;
        };
        if now.duration_since(stamp).unwrap_or_default() > ttl {
            let _ = std::fs::remove_file(entry.path());
        }
    }
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
    cleanup_old_pasted(&dir, SystemTime::now(), PASTED_IMAGE_TTL);
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
    current.card_preset = settings.card_preset;
    // current.last_session_id 保持不变：它是后端专属的恢复点。
    state.config.save(&current)
}

/// 列出用户目录中的贴图样式预设；内置两款由前端补齐。
#[tauri::command]
pub fn list_card_presets(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<PresetInfo>, AppError> {
    state.card_presets.list()
}

/// 读取一个用户预设：资源已在后端转成 data URI，前端可直接拼接进渲染。
#[tauri::command]
pub fn load_card_preset(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<String, AppError> {
    state.card_presets.load_css(&id)
}

/// 打开用户预设目录（不存在则创建）。
#[tauri::command]
pub fn open_card_presets_dir(state: State<'_, Arc<AppState>>) -> Result<(), AppError> {
    state.card_presets.open_dir()
}

/// 是否必须整页导航到目标会话。已在目标会话时跳过：连续追问每次都导航会
/// 重载页面，丢掉消息标记、触发懒加载，并额外付出 input_ready 轮询与稳定等待。
fn needs_navigate(current_chat_id: &str, target_chat_id: &str) -> bool {
    // 开新会话必须回首页以清除当前上下文，即使当前 URL 没有 chat_id。
    if target_chat_id.is_empty() {
        return true;
    }
    current_chat_id != target_chat_id
}

#[cfg(test)]
mod tests {
    use super::{cleanup_old_pasted, needs_navigate};
    use std::time::{Duration, SystemTime};

    // 已在目标会话：跳过整页导航，避免连续追问时重载页面。
    #[test]
    fn skips_navigation_when_already_on_target_chat() {
        assert!(!needs_navigate("chat-1", "chat-1"));
    }

    #[test]
    fn navigates_for_new_chat_even_if_current_is_empty() {
        assert!(needs_navigate("", ""));
        assert!(needs_navigate("chat-1", ""));
    }

    #[test]
    fn navigates_when_target_chat_differs() {
        assert!(needs_navigate("chat-1", "chat-2"));
        assert!(needs_navigate("", "chat-2"));
    }

    /// 粘贴图片只在发送时上传一次；TTL 清理不能误删刚粘贴、仍在使用的文件。
    #[test]
    fn cleanup_removes_only_expired_pasted_images() {
        let dir = std::env::temp_dir().join(format!("qq-pasted-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("创建测试目录");
        let old = dir.join("paste-old.png");
        let fresh = dir.join("paste-fresh.png");
        std::fs::write(&old, b"old").expect("写入旧文件");
        std::fs::write(&fresh, b"fresh").expect("写入新文件");
        let old_time = SystemTime::now() - Duration::from_secs(48 * 60 * 60);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&old)
            .and_then(|f| f.set_modified(old_time))
            .expect("回拨旧文件时间");

        cleanup_old_pasted(&dir, SystemTime::now(), Duration::from_secs(24 * 60 * 60));

        assert!(!old.exists(), "过期文件应被清理");
        assert!(fresh.exists(), "新文件必须保留");
        std::fs::remove_dir_all(&dir).ok();
    }
}
