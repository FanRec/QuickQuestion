import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export type WindowLabel = "orb" | "chat" | "history" | "main";

export async function showWindow(label: WindowLabel) {
  const win = await WebviewWindow.getByLabel(label);
  if (!win) return;
  await win.show();
  await win.setFocus();
}

export async function hideWindow(label: WindowLabel) {
  const win = await WebviewWindow.getByLabel(label);
  if (!win) return;
  await win.hide();
}
