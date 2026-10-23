import type { ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, Moon, Sun } from "lucide-react";
import { NavLink, Link } from "react-router-dom";
import { Brand } from "./Brand";
import { Button } from "./Button";
import { useApp } from "../context/AppContextCore";
import { NotificationButton } from "../notifications/NotificationProvider";

export function PageFrame({ title, description, index, children }: { title: string; description: string; index: string; children: ReactNode }) {
  const { isDark, toggleTheme, toggleLanguage, language } = useApp();
  const zh = language !== "en-US";
  return <div className="product-page">
    <header className="product-header">
      <Link to="/sessions" aria-label={zh ? "返回会话管理" : "Back to Sessions"}><Brand /></Link>
      <nav className="product-nav" aria-label={zh ? "主导航" : "Main navigation"}>
        <NavLink to="/sessions">{zh ? "工作空间" : "Workspace"}</NavLink>
        <NavLink to="/settings">{zh ? "系统设置" : "Settings"}</NavLink>
        <NavLink to="/logs">{zh ? "系统日志" : "Logs"}</NavLink>
      </nav>
      <div className="ml-auto flex items-center gap-1"><NotificationButton />
        <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label={zh ? "切换主题" : "Toggle theme"}>{isDark ? <Sun size={17} /> : <Moon size={17} />}</Button>
        <Button variant="ghost" size="sm" onClick={toggleLanguage} aria-label={zh ? "Switch to English" : "切换到中文"}>{zh ? "EN" : "中"}</Button>
      </div>
    </header>
    <main className="product-page-content">
      <div className="page-heading">
        <div><p className="eyebrow"><span>{index}</span> / WEBSSH GATEWAY</p><h1>{title}<span className="heading-period">.</span></h1><p className="page-description">{description}</p></div>
        <Link to="/sessions" className="page-back"><ArrowLeft size={16} />{zh ? "返回工作空间" : "Back to workspace"}<ArrowUpRight size={15} className="ml-3" /></Link>
      </div>
      <div className="page-sections">{children}</div>
      <footer className="product-footer"><Brand compact /><span>REMOTE SYSTEMS. HUMAN CONTROL.</span></footer>
    </main>
  </div>;
}
