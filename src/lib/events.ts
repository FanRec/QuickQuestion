import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * 监听生命周期统一收口：Tauri 的 listen() 返回 Promise，若在 resolve 前组件
 * 已卸载，cleanup 拿不到 unlisten 函数，监听器会永久泄漏并继续触发过期回调。
 *
 * 这里用 AbortSignal 兜底：调用方创建 controller，传 signal；cleanup 里 abort。
 * - 在 resolve 前 abort：listen 完成后立即自解绑；
 * - 在 resolve 后 abort：走 signal 监听器立即解绑。
 * 两条路径都覆盖，调用方不再需要手动保存 unlisten 函数。
 */
function guarded<T>(
  event: string,
  handler: (payload: T) => void,
  signal?: AbortSignal,
): Promise<UnlistenFn> {
  const wrap = (fn: UnlistenFn): UnlistenFn => {
    if (!signal) return fn;
    if (signal.aborted) {
      fn();
      return () => undefined;
    }
    const unlisten = () => {
      signal.removeEventListener("abort", unlisten);
      fn();
    };
    signal.addEventListener("abort", unlisten, { once: true });
    return unlisten;
  };
  return listen<T>(event, (e) => {
    if (!signal?.aborted) handler(e.payload);
  }).then(wrap);
}

export type StreamPayload =
  | { type: "delta"; exchangeId: string; text: string }
  | { type: "done"; exchangeId: string; text: string }
  | { type: "error"; exchangeId: string; message: string; kind?: string };

export function onStream(handler: (payload: StreamPayload) => void, signal?: AbortSignal) {
  return guarded<StreamPayload>("qq://stream", handler, signal);
}

/// 数据流刷新通知（问答落库后由 chat 窗口发出）。
export function onRefresh(handler: () => void, signal?: AbortSignal) {
  return guarded("qq://refresh", () => handler(), signal);
}

export function emitRefresh() {
  return emit("qq://refresh");
}

/// 主窗口选中某条问答。
export function onSelect(handler: (id: string) => void, signal?: AbortSignal) {
  return guarded<string>("qq://select", handler, signal);
}

export function emitSelect(id: string) {
  return emit("qq://select", id);
}

/// 网页当前所在会话发生变化（切会话 / 发消息后绑定成功）。
export type ActivePayload = { sessionId: string; title: string };

export function onActive(handler: (payload: ActivePayload) => void, signal?: AbortSignal) {
  return guarded<ActivePayload>("qq://active", handler, signal);
}

/// 全局快捷键 Alt+Q：唤起悬浮面板输入条。
export function onHotkeyInput(handler: () => void, signal?: AbortSignal) {
  return guarded("qq://hotkey-input", () => handler(), signal);
}

/// 设置已保存：两套输入条据此重新读取自动消失等配置。
export function onSettingsChanged(handler: () => void, signal?: AbortSignal) {
  return guarded("qq://settings-changed", () => handler(), signal);
}

export function emitSettingsChanged() {
  return emit("qq://settings-changed");
}
