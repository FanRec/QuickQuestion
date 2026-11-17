import { showWindow } from "../lib/windows";
import "./OrbWindow.css";

export function OrbWindow() {
  return (
    <div className="orb-root">
      <div className="orb-drag" data-tauri-drag-region />
      <div className="orb-mini" title="历史记录" onClick={() => showWindow("history")}>
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
          <path
            d="M4 6h16M4 12h16M4 18h11"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </div>
      <div className="orb-main" title="新建提问" onClick={() => showWindow("chat")}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path
            d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9-1.9 5.6-1.9-5.6L4.5 11l5.6-1.9L12 3.5z"
            fill="currentColor"
          />
        </svg>
      </div>
    </div>
  );
}
