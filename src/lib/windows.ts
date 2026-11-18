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
/** 历史形态的整窗高度（含球行）：标题 + 搜索 + 列表 + 底部入口。 */
export const HISTORY_H = 512;

export async function showWindow(label: WindowLabel) {
  const win = await WebviewWindow.getByLabel(label);
  if (!win) return;
  await win.show();
  // 最小化状态下 show() 不会还原窗口，setFocus 也带不到前台；先还原。
  await win.unminimize();
  await win.setFocus();
}

export async function hideWindow(label: WindowLabel) {
  const win = await WebviewWindow.getByLabel(label);
  if (!win) return;
  await win.hide();
}

/// 窗口几何操作按窗口串行化：每步都是"读位置 → 写尺寸 → 写位置"的多段
/// IPC，并发执行会读到中间态（新尺寸 + 旧位置），锚点算错导致球/输入条漂移。
/// 触发源众多（形态切换、内容高度上报、Alt+Q 唤起），靠调用方自觉没用，这里统一排队。
const geometryQueues = new Map<string, Promise<unknown>>();

function enqueueGeometry<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (geometryQueues.get(key) ?? Promise.resolve()).then(task, task);
  geometryQueues.set(key, next);
  return next;
}

/// JS 侧记账各窗口的已知几何（物理像素）。即使操作串行了也不够：OS 应用
/// 窗口变更本身是异步的，下一个操作直接回读窗口仍可能拿到中间态。
/// 所以锚点一律以这里记录的"上一次写入意图"为准：
/// - 每次几何操作写完同步更新缓存（确切知道落在哪）；
/// - 拖动等外部移动由组件在 onMoved 事件里回填（noteWindowPosition）。
type Geometry = { x: number; y: number; w: number; h: number };
const geometries = new Map<string, Geometry>();
/// 各窗口最近一次写入缓存的时间。写入后短暂窗口内的 Moved 事件一律忽略：
/// 自己的 setPosition 也会触发 Moved，晚到的旧事件会把新缓存拖回旧值。
const lastWriteAt = new Map<string, number>();
const MOVE_GUARD_MS = 150;

/** 拖动等外部移动后回填缓存。 */
export function noteWindowPosition(label: WindowLabel, x: number, y: number) {
  const g = geometries.get(label);
  if (!g) return;
  if (Date.now() - (lastWriteAt.get(label) ?? 0) < MOVE_GUARD_MS) return;
  geometries.set(label, { ...g, x, y });
}

/** 几何操作写入：既记目标值，也记写入时间供 Moved 事件守卫用。 */
function rememberGeometry(label: WindowLabel, g: Geometry) {
  geometries.set(label, g);
  lastWriteAt.set(label, Date.now());
}

/** 缓存优先；无记录时（启动后首次操作）回退到实测。 */
async function knownGeometry(label: WindowLabel): Promise<Geometry> {
  const known = geometries.get(label);
  if (known) return known;
  const win =
    label === "panel" ? getCurrentWindow() : await WebviewWindow.getByLabel(label);
  if (!win) throw new Error(`窗口不存在：${label}`);
  const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
  const g = { x: pos.x, y: pos.y, w: size.width, h: size.height };
  geometries.set(label, g);
  return g;
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
export function placePanelBottomRight(height: number) {
  return enqueueGeometry("panel", async () => {
    const win = getCurrentWindow();
    // 窗口未显示时 currentMonitor 拿不到所在屏，必须先 show 再算位置。
    await win.show();
    const area = await workArea();
    if (!area) return;
    const s = area.scale;
    const w = Math.round(ORB_W * s);
    const h = Math.round(height * s);
    const pad = Math.round(16 * s);
    const x = area.x + area.w - w - pad;
    const y = area.y + area.h - h - pad;
    await win.setSize(new PhysicalSize(w, h));
    await win.setPosition(new PhysicalPosition(x, y));
    rememberGeometry("panel", { x, y, w, h });
  });
}

/**
 * 把输入条窗口摆到锚点附近：**底边贴近锚点，向上生长**（气泡在上方）。
 * 水平以锚点为中心，越界夹回屏幕内；下方空间不足时翻到锚点上方。
 * 绝对定位，不依赖窗口当前位置。
 */
export function placeComposer(anchor: ComposerAnchor, height: number, width = PANEL_W) {
  return enqueueGeometry("composer", async () => {
    const win = await WebviewWindow.getByLabel("composer");
    if (!win) return;
    const area = await workArea();
    if (!area) return;
    const s = area.scale;
    const w = Math.round(width * s);
    const h = Math.round(height * s);
    const gap = Math.round(8 * s);
    const pad = Math.round(8 * s);

    // 水平：以光标为中心，左右夹紧。
    const x = Math.max(area.x + pad, Math.min(anchor.x - Math.round(w / 2), area.x + area.w - w - pad));

    // 垂直：底边在锚点下方 gap 处；下方放不下就翻到上方（底边在锚点上方 gap 处）。
    let y = anchor.y + gap;
    if (y + h > area.y + area.h - pad) {
      y = anchor.y - gap - h;
    }
    y = Math.max(area.y + pad, y);

    await win.setSize(new PhysicalSize(w, h));
    await win.setPosition(new PhysicalPosition(x, y));
    rememberGeometry("composer", { x, y, w, h });
  });
}

/** 输入条窗口高度变化时，保持底边不动向上生长（气泡长高）。 */
export function resizeComposerKeepingBottom(height: number, width = PANEL_W) {
  return enqueueGeometry("composer", async () => {
    const win = await WebviewWindow.getByLabel("composer");
    if (!win) return;
    const g = await knownGeometry("composer");
    const scale = await win.scaleFactor();
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    if (g.w === w && g.h === h) return;
    const x = g.x;
    const y = g.y + g.h - h;
    await win.setSize(new PhysicalSize(w, h));
    await win.setPosition(new PhysicalPosition(x, y));
    rememberGeometry("composer", { x, y, w, h });
  });
}

/**
 * 以窗口右下角为锚点改变尺寸，使球在展开/收起时位置不动。
 * 锚点取 JS 记账的已知几何，不回读 OS（见 geometries 注释）。
 * 拖动由 Tauri 接管，锚点经 onMoved 回填。
 */
export function resizePanelKeepingAnchor(height: number, width = PANEL_W) {
  return enqueueGeometry("panel", async () => {
    const win = getCurrentWindow();
    const g = await knownGeometry("panel");
    const scale = await win.scaleFactor();
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    if (g.w === w && g.h === h) return;
    const x = g.x + g.w - w;
    const y = g.y + g.h - h;
    await win.setSize(new PhysicalSize(w, h));
    await win.setPosition(new PhysicalPosition(x, y));
    rememberGeometry("panel", { x, y, w, h });
  });
}
