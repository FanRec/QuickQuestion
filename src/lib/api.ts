import { invoke } from "@tauri-apps/api/core";
import type { Exchange } from "./types";

export function listExchanges(): Promise<Exchange[]> {
  return invoke<Exchange[]>("list_exchanges");
}

export function getExchange(id: string): Promise<Exchange | null> {
  return invoke<Exchange | null>("get_exchange", { id });
}

export function deleteExchange(id: string): Promise<void> {
  return invoke<void>("delete_exchange", { id });
}

export function copyMarkdown(id: string): Promise<string> {
  return invoke<string>("copy_markdown", { id });
}

export function sendMessage(text: string, files: string[]): Promise<string> {
  return invoke<string>("send_message", { text, files });
}

export function cancelMessage(): Promise<void> {
  return invoke<void>("cancel_message");
}

export function browserStatus(): Promise<{
  ready: boolean;
  port: number;
  pageUrl: string;
  inputReady: boolean;
}> {
  return invoke("browser_status");
}

export interface Settings {
  browserPort: number;
  quietMs: number;
}

export function getSettings(): Promise<Settings> {
  return invoke("get_settings");
}

export function updateSettings(settings: Settings): Promise<void> {
  return invoke("update_settings", { settings });
}
