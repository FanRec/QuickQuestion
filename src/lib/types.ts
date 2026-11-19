export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 对应的 DeepSeek 网页会话 UUID；空表示尚未绑定。 */
  deepseekChatId: string;
}

export interface Exchange {
  id: string;
  sessionId: string;
  createdAt: number;
  questionText: string;
  answerText: string;
  imageNames: string[];
}

/** 历史列表里的问题标题：纯图片提问没有文字，给一个可识别的占位。 */
export const questionLabel = (e: Exchange) =>
  e.questionText.trim() || (e.imageNames.length ? "[图片]" : "未命名问题");

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
