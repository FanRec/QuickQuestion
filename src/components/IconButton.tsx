import type { ReactNode } from "react";
import "./IconButton.css";

interface IconButtonProps {
  children: ReactNode;
  title?: string;
  onClick?: () => void;
}

export function IconButton({ children, title, onClick }: IconButtonProps) {
  return (
    <button
      type="button"
      className="icon-button"
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
