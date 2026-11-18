import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { GlassCard } from "../components/GlassCard";
import { IconButton } from "../components/IconButton";
import { cancelMessage } from "../lib/api";
import { emitRefresh, onStream } from "../lib/events";
import { hideWindow } from "../lib/windows";
import "./ChatWindow.css";

export function ChatWindow() {
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const streamingRef = useRef(false);

  const setStream = (value: boolean) => {
    streamingRef.current = value;
    setStreaming(value);
  };

  const closeChat = () => {
    if (streamingRef.current) void cancelMessage();
    setStream(false);
    void hideWindow("chat");
  };

  useEffect(() => {
    inputRef.current?.focus();
    let unlisten: (() => void) | undefined;
    onStream((payload) => {
      if (payload.type === "delta") {
        setAnswer(payload.text);
      } else if (payload.type === "done") {
        setAnswer(payload.text);
        setStream(false);
        void emitRefresh();
      } else {
        setError(payload.message);
        setStream(false);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const attachImage = async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });
    if (!selected) return;
    setImages((prev) => [...prev, ...(Array.isArray(selected) ? selected : [selected])]);
  };

  const submit = async () => {
    const value = text.trim();
    if (!value && images.length === 0) return;
    setAnswer("");
    setError(null);
    setStream(true);
    setText("");
    const sentImages = images;
    setImages([]);
    try {
      await invoke<string>("send_message", { text: value, files: sentImages });
    } catch (e) {
      setError(String(e));
      setStream(false);
    }
  };

  return (
    <div className="chat-root">
      <GlassCard className="chat-card">
        <div className="chat-header">
          <span className="chat-title">问点什么</span>
          <IconButton title="关闭" onClick={closeChat}>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
            </svg>
          </IconButton>
        </div>

        <div className="chat-body">
          {streaming && !answer && <div className="chat-hint">正在思考…</div>}
          {answer !== null && <div className="chat-bubble">{answer}</div>}
          {error && <div className="chat-error">{error}</div>}
        </div>

        {images.length > 0 && (
          <div className="chat-attachments">
            {images.map((path) => (
              <span className="chat-chip" key={path} title={path}>
                {path.split(/[\\/]/).pop()}
              </span>
            ))}
          </div>
        )}

        <div className="chat-input-row">
          <IconButton title="添加图片" onClick={attachImage}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.7" fill="none" />
              <circle cx="8.5" cy="9.5" r="1.5" fill="currentColor" />
              <path d="M4 17l5-5 4 4 3-3 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </IconButton>
          <input
            ref={inputRef}
            className="chat-input"
            placeholder="输入问题，回车发送…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
              if (e.key === "Escape") closeChat();
            }}
          />
        </div>
      </GlassCard>
    </div>
  );
}
