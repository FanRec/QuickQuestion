import { emit, listen } from "@tauri-apps/api/event";

export type StreamPayload =
  | { type: "delta"; exchangeId: string; text: string }
  | { type: "done"; exchangeId: string; text: string }
  | { type: "error"; exchangeId: string; message: string };

export function onStream(handler: (payload: StreamPayload) => void) {
  return listen<StreamPayload>("qq://stream", (event) => handler(event.payload));
}

/// 数据流刷新通知（问答落库后由 chat 窗口发出）。
export function onRefresh(handler: () => void) {
  return listen("qq://refresh", () => handler());
}

export function emitRefresh() {
  return emit("qq://refresh");
}

/// 主窗口选中某条问答。
export function onSelect(handler: (id: string) => void) {
  return listen<string>("qq://select", (event) => handler(event.payload));
}

export function emitSelect(id: string) {
  return emit("qq://select", id);
}

/// 网页当前所在会话发生变化（切会话 / 发消息后绑定成功）。
export type ActivePayload = { sessionId: string; chatId: string };

export function onActive(handler: (payload: ActivePayload) => void) {
  return listen<ActivePayload>("qq://active", (event) => handler(event.payload));
}

/// 全局快捷键 Alt+Q：唤起悬浮面板输入条。
export function onHotkeyInput(handler: () => void) {
  return listen("qq://hotkey-input", () => handler());
}

/// 设置已保存：两套输入条据此重新读取自动消失等配置。
export function onSettingsChanged(handler: () => void) {
  return listen("qq://settings-changed", () => handler());
}

export function emitSettingsChanged() {
  return emit("qq://settings-changed");
}
