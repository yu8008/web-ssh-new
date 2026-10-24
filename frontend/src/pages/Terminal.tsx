import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import "@xterm/xterm/css/xterm.css";
import { useIsMobile } from "../lib/hooks/useIsMobile";
import { TerminalDesktop } from "./terminal/TerminalDesktop";
import { TerminalMobile } from "./terminal/TerminalMobile";
import { useTerminalSession } from "./terminal/useTerminalSession";

export function TerminalPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const state = useTerminalSession(sessionId);
  const pageTitle = (state.sessionInfo?.id === sessionId ? state.sessionInfo?.name.trim() : "") || "WebSSH Gateway";

  React.useEffect(() => {
    document.title = pageTitle;
    return () => { document.title = "WebSSH Gateway"; };
  }, [pageTitle]);

  const handleBack = React.useCallback(() => {
    navigate("/sessions");
  }, [navigate]);

  return isMobile ? <TerminalMobile state={state} onBack={handleBack} /> : <TerminalDesktop state={state} onBack={handleBack} />;
}
