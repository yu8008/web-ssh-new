import { ArrowUpRight, Circle, Server } from "lucide-react";
import { SignalArtwork } from "../../components/SignalArtwork";
import type { SessionsState } from "./useSessionsState";

export function WorkspaceIntro({ state, onViewActive }: { state: SessionsState; onViewActive: () => void }) {
  const active = state.sessions.filter(item => item.status === "active").length;
  return <section className="workspace-intro" aria-label={state.t("工作空间概览", "Workspace overview")}>
    <div><p className="eyebrow"><span>01</span> / {state.t("你的远端工作空间", "YOUR REMOTE WORKSPACE")}</p>
      <h1>{state.t("把远端，", "Your remote")}<br /><span>{state.t("带到眼前。", "universe.")}</span></h1>
      <p>{state.t("每一次连接，都是工作的延续。", "Every connection. A continuation of your work.")}</p>
    </div>
    <SignalArtwork className="workspace-art" />
    <div className="workspace-stats">
      <button className="workspace-stat" onClick={onViewActive} aria-label={state.t(`查看 ${active} 个在线会话`, `View ${active} active sessions`)}><strong>{String(active).padStart(2, "0")}</strong><span><Circle size={7} fill="currentColor" className="text-ok" />{state.t("在线会话", "ACTIVE SESSIONS")}<ArrowUpRight size={12} /></span></button>
      <button className="workspace-stat" onClick={() => state.setShowCreateForm(true)} aria-label={state.t("新建连接", "New connection")}><strong>{String(state.connections.length).padStart(2, "0")}</strong><span><Server size={10} />{state.t("已保存连接", "CONNECTIONS")}<ArrowUpRight size={12} /></span></button>
    </div>
  </section>;
}
