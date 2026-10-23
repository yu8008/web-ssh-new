import { useApp } from "../context/AppContextCore";
import { Loader2 } from "lucide-react";
import { Brand } from "./Brand";

export function RouteFallback() {
  const { isDark } = useApp();

  return (
    <div className={`flex min-h-screen items-center justify-center text-sm ${isDark ? "bg-canvas text-ink-soft" : "bg-canvas text-ink-soft"}`}>
      <div className="flex flex-col items-center gap-7"><Brand /><span className="flex items-center gap-2 text-xs text-muted"><Loader2 size={14} className="animate-spin" />加载中 / Loading</span></div>
    </div>
  );
}
