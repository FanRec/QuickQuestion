/// 健康检查命令；M0 用于验证 IPC 链路，后续里程碑在此注册真实命令。
#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}
