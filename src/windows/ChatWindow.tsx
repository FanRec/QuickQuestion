import { useEffect, useRef, useState } from "react";
import { GlassCard } from "../components/GlassCard";
import { IconButton } from "../components/IconButton";
import { hideWindow } from "../lib/windows";
import "./ChatWindow.css";

export function ChatWindow() {
  const [text, setText] = useState("");
  const [bubble, setBubble] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    // M1 本地模拟；M3 替换为真实流式回传。
    setBubble(`已收到：${value}\n（真实回复将在 M3 接入）`);
    setText("");
  };

  return (
    <div className="chat-root">
      <GlassCard className="chat-card">
        <div className="chat-header">
          <span className="chat-title">问点什么</span>
          <IconButton title="关闭" onClick={() => hideWindow("chat")}>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          </IconButton>
        </div>

        <div className="chat-body">
          {bubble && <div className="chat-bubble">{bubble}</div>}
        </div>

        <div className="chat-input-row">
          <input
            ref={inputRef}
            className="chat-input"
            placeholder="输入问题，回车发送…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape") hideWindow("chat");
            }}
          />
        </div>
      </GlassCard>
    </div>
  );
}
