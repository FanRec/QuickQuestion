import { invoke } from "@tauri-apps/api/core";
import type { Exchange, Session } from "./types";

export interface SendResult {
  exchangeId: string;
  sessionId: string;
}

/** 隐藏悬浮球。必须走后端，托盘菜单文案才能跟着变。 */
export function setPanelVisible(visible: boolean): Promise<void> {
  return invoke<void>("set_panel_visible", { visible });
}

/** 发送消息。会话编排在后端完成；前端只表达"是否要开新会话"的意图。 */
export function sendMessage(input: {
  text: string;
  files: string[];
  deepThink: boolean;
  webSearch: boolean;
  sessionId: string;
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

/** 全部问答（倒序）。按会话分组由前端从全集派生，IPC 不再带过滤参数。 */
export function listExchanges(): Promise<Exchange[]> {
  return invoke<Exchange[]>("list_exchanges");
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

/**
 * 真正切换会话：后端把网页导航到该会话并广播 `qq://active`。
 * 与左栏单击（只改浏览焦点）不同，这条路会驱动网页，耗时可达数秒。
 */
export function switchSession(id: string): Promise<Session> {
  return invoke<Session>("switch_session", { id });
}

/** 是否有问答正在进行中（全局，两套输入条共用）。 */
export function isSending(): Promise<boolean> {
  return invoke<boolean>("is_sending");
}

export function deleteSession(id: string): Promise<void> {
  return invoke<void>("delete_session", { id });
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
  /** 贴图样式预设 id；内置 classic/plain 或用户目录名。 */
  cardPreset: string;
}

export function getSettings(): Promise<Settings> {
  return invoke("get_settings");
}

export function updateSettings(settings: Settings): Promise<void> {
  return invoke("update_settings", { settings });
}

export interface CardPresetInfo {
  id: string;
  label: string;
  description: string;
}

export function listCardPresets(): Promise<CardPresetInfo[]> {
  return invoke("list_card_presets");
}

export function loadCardPreset(id: string): Promise<string> {
  return invoke("load_card_preset", { id });
}

export function openCardPresetsDir(): Promise<void> {
  return invoke("open_card_presets_dir");
}
