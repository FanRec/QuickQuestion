import type { ReactNode } from "react";
import "./IconButton.css";

interface IconButtonProps {
  children: ReactNode;
  title?: string;
  onClick?: () => void;
  variant?: "subtle" | "accent";
}

export function IconButton({ children, title, onClick, variant = "subtle" }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-button icon-button--${variant}`}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
