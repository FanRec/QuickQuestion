import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/global.css";
import { OrbWindow } from "./windows/OrbWindow";
import { ChatWindow } from "./windows/ChatWindow";
import { HistoryWindow } from "./windows/HistoryWindow";
import { MainWindow } from "./windows/MainWindow";
import { applyTheme, loadTheme, watchTheme } from "./lib/theme";

const windowId = new URLSearchParams(window.location.search).get("window");
applyTheme(loadTheme());
watchTheme();

function App() {
  switch (windowId) {
    case "chat":
      return <ChatWindow />;
    case "history":
      return <HistoryWindow />;
    case "main":
      return <MainWindow />;
    case "orb":
    default:
      return <OrbWindow />;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
