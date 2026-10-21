import React from "react";
import { useSessionsState } from "./sessions/useSessionsState";
import { SessionsWorkbench } from "./sessions/SessionsWorkbench";

export function Sessions() {
  const state = useSessionsState();
  return <SessionsWorkbench state={state} />;
}
