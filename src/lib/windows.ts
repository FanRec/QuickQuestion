import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
  primaryMonitor,
} from "@tauri-apps/api/window";

export type WindowLabel = "panel" | "main" | "composer";

/** 输入条的定位锚点：光标（Alt+Q）或大球（点击唤起）。 */
export type ComposerAnchor = { x: number; y: number };

/** 面板几何（逻辑像素）。球行固定，输入条 / 历史 / 气泡按需叠加。 */
export const ORB_W = 132;
export const ORB_H = 56;
export const PANEL_W = 320;
export const INPUT_H = 46;
/** 待发送图片那一行（缩略图 40 + 间距 6）。 */
export const IMAGES_H = 46;
export const BUBBLE_MAX_H = 148;
/** 历史形态的整窗高度（含球行）。 */
export const HISTORY_H = 380;

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

/** 显示器工作区（已排除任务栏）。窗口未上屏时 currentMonitor 可能为 null，退回主屏。 */
async function workArea() {
  const mon = (await currentMonitor()) ?? (await primaryMonitor());
  if (!mon) return null;
  const area = mon.workArea ?? { position: mon.position, size: mon.size };
  return {
    x: area.position.x,
    y: area.position.y,
    w: area.size.width,
    h: area.size.height,
    scale: mon.scaleFactor,
  };
}

/** 首次摆放：先上屏再定位，贴屏幕右下角，初始为收起态（只有球）。 */
export async function placePanelBottomRight(height: number) {
  const win = getCurrentWindow();
  // 窗口未显示时 currentMonitor 拿不到所在屏，必须先 show 再算位置。
  await win.show();
  const area = await workArea();
  if (!area) return;
  const s = area.scale;
  const w = Math.round(ORB_W * s);
  const h = Math.round(height * s);
  const pad = Math.round(16 * s);
  await win.setSize(new PhysicalSize(w, h));
  await win.setPosition(
    new PhysicalPosition(area.x + area.w - w - pad, area.y + area.h - h - pad),
  );
}

/**
 * 把输入条窗口摆到锚点附近：**底边贴近锚点，向上生长**（气泡在上方）。
 * 水平以锚点为中心，越界夹回屏幕内；下方空间不足时翻到锚点上方。
 * 返回是否翻到了上方，供调用方决定气泡展开方向。
 */
export async function placeComposer(anchor: ComposerAnchor, height: number, width = PANEL_W) {
  const win = await WebviewWindow.getByLabel("composer");
  if (!win) return false;
  const area = await workArea();
  if (!area) return false;
  const s = area.scale;
  const w = Math.round(width * s);
  const h = Math.round(height * s);
  const gap = Math.round(8 * s);
  const pad = Math.round(8 * s);

  // 水平：以光标为中心，左右夹紧。
  const x = Math.max(area.x + pad, Math.min(anchor.x - Math.round(w / 2), area.x + area.w - w - pad));

  // 垂直：底边在锚点下方 gap 处；下方放不下就翻到上方（底边在锚点上方 gap 处）。
  let y = anchor.y + gap;
  let flipped = false;
  if (y + h > area.y + area.h - pad) {
    y = anchor.y - gap - h;
    flipped = true;
  }
  y = Math.max(area.y + pad, y);

  await win.setSize(new PhysicalSize(w, h));
  await win.setPosition(new PhysicalPosition(x, y));
  return flipped;
}

/** 输入条窗口高度变化时，保持底边不动向上生长（气泡长高）。 */
export async function resizeComposerKeepingBottom(height: number, width = PANEL_W) {
  const win = await WebviewWindow.getByLabel("composer");
  if (!win) return;
  const scale = await win.scaleFactor();
  const pos = await win.outerPosition();
  const size = await win.outerSize();
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  if (size.width === w && size.height === h) return;
  const bottom = pos.y + size.height;
  await win.setSize(new PhysicalSize(w, h));
  await win.setPosition(new PhysicalPosition(pos.x, bottom - h));
}

/**
 * 以窗口右下角为锚点改变尺寸，使球在展开/收起时位置不动。
 * 拖动由 Tauri 接管，锚点随之更新。
 */
export async function resizePanelKeepingAnchor(height: number, width = PANEL_W) {
  const win = getCurrentWindow();
  const scale = await win.scaleFactor();
  const pos = await win.outerPosition();
  const size = await win.outerSize();
  const anchorX = pos.x + size.width;
  const anchorY = pos.y + size.height;
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  if (size.width === w && size.height === h) return;
  await win.setSize(new PhysicalSize(w, h));
  await win.setPosition(new PhysicalPosition(anchorX - w, anchorY - h));
}
