import React from "react";
import type { SoundPreferences, TerminalNotice } from "./notificationCore";

export type NotificationContextValue = {
  events: TerminalNotice[]; preferences: SoundPreferences; ready: boolean; connected: boolean;
  open: () => void; update: (next: Partial<SoundPreferences>) => void;
  enable: () => Promise<void>; preview: (attention: boolean) => Promise<void>;
};
export const NotificationContext = React.createContext<NotificationContextValue | null>(null);
