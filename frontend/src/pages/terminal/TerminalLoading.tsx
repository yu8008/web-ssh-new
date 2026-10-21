import { LoaderCircle } from "lucide-react";
import type { TerminalSessionState } from "./useTerminalSession";

export function TerminalLoading({ state }: { state: Pick<TerminalSessionState, "hasRenderedOutput" | "connectionState" | "t"> }) {
  if (state.hasRenderedOutput || state.connectionState === "closed") return null;
  return (
    <div role="status" className="pointer-events-none absolute left-8 top-8 flex items-center gap-2 text-sm text-ink-soft">
      <LoaderCircle size={16} className="motion-safe:animate-spin" aria-hidden="true" />
      {state.connectionState === "connecting"
        ? state.t("正在连接终端…", "Connecting to terminal…")
        : state.t("等待终端输出…", "Waiting for terminal output…")}
    </div>
  );
}
