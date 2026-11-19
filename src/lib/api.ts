import { invoke } from "@tauri-apps/api/core";
import type { Exchange, Session } from "./types";

export interface SendResult {
  exchangeId: string;
  sessionId: string;
}

/** 发送消息。会话编排在后端完成；前端只表达"是否要开新会话"的意图。 */
export function sendMessage(input: {
  text: string;
  files: string[];
  deepThink: boolean;
  webSearch: boolean;
  sessionId: string;
  injectPrompt: boolean;
  newSession: boolean;
}): Promise<SendResult> {
  return invoke<SendResult>("send_message", input);
}

/// 后端错误是 `{ message, kind? }` 结构；kind 决定 UI 行为（如登录引导）。
export function errText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(error);
    } catch {
      // 落到 String
    }
  }
  return String(error);
}

export function errKind(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    const kind = (error as { kind?: unknown }).kind;
    if (typeof kind === "string") return kind;
  }
  return undefined;
}

export function listExchanges(sessionId?: string): Promise<Exchange[]> {
  return invoke<Exchange[]>("list_exchanges", { sessionId: sessionId ?? null });
}

export function listSessions(): Promise<Session[]> {
  return invoke<Session[]>("list_sessions");
}

/** 网页当前所在会话；未绑定任何本地会话时返回 null。 */
export function activeSession(): Promise<Session | null> {
  return invoke<Session | null>("active_session");
}

export function rememberSession(id: string): Promise<void> {
  return invoke<void>("remember_session", { id });
}

/** 是否有问答正在进行中（全局，两套输入条共用）。 */
export function isSending(): Promise<boolean> {
  return invoke<boolean>("is_sending");
}

/// 新建会话：会同时在网页端开一个新对话。
export function createSession(title?: string): Promise<Session> {
  return invoke<Session>("create_session", { title: title ?? null });
}

export function deleteSession(id: string): Promise<void> {
  return invoke<void>("delete_session", { id });
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

export function cancelMessage(): Promise<void> {
  return invoke<void>("cancel_message");
}

export function browserStatus(): Promise<{
  ready: boolean;
  port: number;
  pageUrl: string;
  inputReady: boolean;
  needsLogin: boolean;
  loginReason: string;
}> {
  return invoke("browser_status");
}

export interface Settings {
  browserPort: number;
  quietMs: number;
  systemPrompt: string;
  hotkey: string;
  /** 上次选中的会话；只透传不修改，否则保存设置会把后端记住的值冲掉。 */
  lastSessionId: string;
  /** 回复气泡自动消失秒数；0 = 永不。 */
  bubbleHideSecs: number;
  /** 独立输入条整体自动收起秒数；0 = 永不。 */
  popupHideSecs: number;
}

export function getSettings(): Promise<Settings> {
  return invoke("get_settings");
}

export function updateSettings(settings: Settings): Promise<void> {
  return invoke("update_settings", { settings });
}
