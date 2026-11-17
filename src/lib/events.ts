import { listen } from "@tauri-apps/api/event";

export type StreamPayload =
  | { type: "delta"; exchangeId: string; text: string }
  | { type: "done"; exchangeId: string; text: string }
  | { type: "error"; exchangeId: string; message: string };

export function onStream(handler: (payload: StreamPayload) => void) {
  return listen<StreamPayload>("qq://stream", (event) => handler(event.payload));
}
