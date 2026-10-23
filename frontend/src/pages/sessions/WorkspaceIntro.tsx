import { ArrowUpRight, Circle, Plus, Server, SquareTerminal } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { SignalArtwork } from "../../components/SignalArtwork";
import type { SessionsState } from "./useSessionsState";

export function WorkspaceIntro({ state, onViewActive }: { state: SessionsState; onViewActive: () => void }) {
  const navigate = useNavigate();
  const active = state.sessions.filter(item => item.status === "active");
  const recent = active.reduce<typeof active[number] | undefined>((latest, item) =>
    !latest || (item.last_activity || item.started_at) > (latest.last_activity || latest.started_at) ? item : latest, undefined);
  return <section className="workspace-intro" aria-label={state.t("工作空间概览", "Workspace overview")}>
    <div className="workspace-intro-copy">
      <p className="eyebrow"><span className="eyebrow-rule" /> 01 / YOUR WORKSPACE</p>
      <h1>{state.t("远端世界，", "Your world,")}<br /><span>{state.t("由你掌控。", "connected.")}</span></h1>
      <p>{state.t("每一次连接，都是工作的延续。", "Every connection. A continuation of your work.")}</p>
      <button className="workspace-resume" onClick={() => recent ? navigate(`/terminal/${recent.id}`) : state.setShowCreateForm(true)}>
        {recent ? <SquareTerminal size={16} /> : <Plus size={16} />}
        <span>{recent ? state.t("继续工作", "Resume work") : (state.connections.length ? state.t("新建连接", "New connection") : state.t("建立第一条连接", "Make your first connection"))}</span>
        {recent && <span className="workspace-resume-name">{recent.name}</span>}
        <ArrowUpRight size={15} />
      </button>
    </div>
    <SignalArtwork className="workspace-art" interactive />
    <div className="workspace-stats">
      <p className="workspace-stats-label">WORKSPACE / OVERVIEW</p>
      <button className="workspace-stat" onClick={onViewActive} aria-label={state.t(`查看 ${active.length} 个在线会话`, `View ${active.length} active sessions`)}>
        <span><Circle size={6} fill="currentColor" className="text-ok" />{state.t("在线会话", "ACTIVE SESSIONS")}</span>
        <strong>{String(active.length).padStart(2, "0")}<ArrowUpRight size={19} strokeWidth={1.3} /></strong>
      </button>
      <button className="workspace-stat" onClick={() => state.setShowCreateForm(true)} aria-label={state.t("新建连接", "New connection")}>
        <span><Server size={10} />{state.t("已保存连接", "CONNECTIONS")}</span>
        <strong>{String(state.connections.length).padStart(2, "0")}<ArrowUpRight size={19} strokeWidth={1.3} /></strong>
      </button>
    </div>
  </section>;
}
