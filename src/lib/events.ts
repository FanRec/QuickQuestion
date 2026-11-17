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
