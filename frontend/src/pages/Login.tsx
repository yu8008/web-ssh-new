import React from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, Fingerprint, Layers, LockKeyhole, Moon, Network, Sun } from "lucide-react";
import { Brand } from "../components/Brand";
import { SignalArtwork } from "../components/SignalArtwork";
import { Button } from "../components/Button";
import { Input } from "../components/Input";
import { useToast } from "../components/ToastContext";
import { useApp } from "../context/AppContextCore";
import { login, storeAuthData } from "../lib/api";
import { parseJwt } from "../lib/auth";

const copy = {
  title: { zh: "进入工作空间", en: "Welcome back" },
  subtitle: { zh: "一个入口，连接你的服务器与工作现场。", en: "Your servers. Your sessions. Your space." },
  username: { zh: "用户名", en: "Username" },
  password: { zh: "密码", en: "Password" },
  remember: { zh: "记住我", en: "Keep me signed in" },
  submit: { zh: "登录", en: "Sign in" },
  submitting: { zh: "正在登录…", en: "Signing in…" },
  forgot: { zh: "忘记密码？", en: "Forgot password?" },
  hint: { zh: "仅限已授权的工作空间成员访问", en: "For authorized workspace members" },
  headline: { zh: "服务器，就在这个标签页里。", en: "Your servers, in one tab." },
  lead: {
    zh: "保存连接、启动持久会话、翻看文件，不用再在多个终端窗口之间切换。",
    en: "Save connections, keep sessions alive and move files without switching terminal windows.",
  },
  features: [
    { zh: "增强持久会话，让工作持续在线", en: "Persistent sessions keep your work moving" },
    { zh: "连接、会话、文件与监控在同一个工作台", en: "Connections, sessions, files and metrics in one place" },
    { zh: "凭据加密存储，权限按账号隔离", en: "Credentials encrypted at rest, scoped per account" },
  ],
  resetTitle: { zh: "重置密码", en: "Reset password" },
  resetBody: {
    zh: "Web 端不支持自助重置。请联系管理员在服务器上执行下面的命令，并按提示输入新密码。",
    en: "Self-service reset is not available. Ask an admin to run the command below on the server and set a new password.",
  },
  resetHint: {
    zh: "执行后需要重新登录，并会强制修改一次密码。",
    en: "You will be asked to change the password again after signing in.",
  },
  done: { zh: "我知道了", en: "Got it" },
  enterUsername: { zh: "请输入用户名后再重置密码", en: "Enter a username before resetting" },
} as const;

export function Login() {
  const [username, setUsername] = React.useState("admin");
  const [password, setPassword] = React.useState("");
  const [rememberMe, setRememberMe] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [resetDialogOpen, setResetDialogOpen] = React.useState(false);
  const [resetUsername, setResetUsername] = React.useState("");
  const navigate = useNavigate();
  const { push } = useToast();
  const { language, isDark, toggleTheme, toggleLanguage } = useApp();
  const zh = language !== "en-US";
  const tr = React.useCallback(
    (key: Exclude<keyof typeof copy, "features">) => {
      const entry = copy[key] as { zh: string; en: string };
      return zh ? entry.zh : entry.en;
    },
    [zh]
  );
  const resetCommand = "cd backend && python -m app.cli reset-password --username " + (resetUsername || "<用户名>");

  React.useEffect(() => {
    if (localStorage.getItem("token") || sessionStorage.getItem("token")) {
      navigate("/sessions");
    }
  }, [navigate]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      const response = await login(username, password, rememberMe);
      const payload = parseJwt(response.access_token);
      if (!payload?.sub) {
        throw new Error(zh ? "登录凭证无效" : "Invalid credentials");
      }
      storeAuthData(response.access_token, String(payload.sub), rememberMe);
      if (response.force_password_change) {
        navigate("/force-password");
      } else {
        navigate("/sessions");
      }
    } catch (error) {
      push(error instanceof Error ? error.message : zh ? "登录失败" : "Sign in failed");
    } finally {
      setLoading(false);
    }
  };

  const handleOpenResetDialog = () => {
    const trimmed = username.trim();
    if (!trimmed) {
      push(zh ? copy.enterUsername.zh : copy.enterUsername.en);
      return;
    }
    setResetUsername(trimmed);
    setResetDialogOpen(true);
  };

  const isDisabled = !username || !password || loading;

  return (
    <div className="auth-layout">
      <aside className="auth-story">
        <div className="auth-story-top"><Brand /><span className="auth-kicker">BUILT FOR YOUR NEXT CONNECTION</span></div>
        <SignalArtwork className="auth-art" interactive />
        <div className="auth-copy">
          <p className="eyebrow"><span>01</span> / REMOTE SYSTEMS. HUMAN CONTROL.</p>
          <h1>{zh ? <>远端，<br />近在<span>眼前。</span></> : <>Remote.<br /><span>Within reach.</span></>}</h1>
          <p>{tr("lead")}</p>
        </div>
        <div className="auth-bottom">
          <div className="auth-features">{copy.features.map((feature, index) => {
            const Icon = [Layers, Network, Fingerprint][index];
            return <div key={feature.zh}><span className="auth-feature-index">0{index + 1}</span><Icon size={19} strokeWidth={1.5} aria-hidden="true" /><p>{zh ? feature.zh : feature.en}</p></div>;
          })}</div>
          <div className="auth-caption"><span>ONE GATEWAY. EVERY POSSIBILITY.</span><span>WEBSSH / GATEWAY</span></div>
        </div>
      </aside>
      <main className="auth-panel">
        <div className="auth-controls">
          <Button variant="ghost" size="sm" onClick={toggleLanguage} aria-label={zh ? "Switch to English" : "切换到中文"}>{zh ? "EN" : "中"}</Button>
          <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label={zh ? "切换主题" : "Toggle theme"}>{isDark ? <Sun size={17} /> : <Moon size={17} />}</Button>
        </div>
        <div className="auth-form">
          <p className="eyebrow"><span /> {zh ? "你的远端工作空间" : "YOUR REMOTE WORKSPACE"}</p>
          <h2>{tr("title")}</h2><p className="auth-subtitle">{tr("subtitle")}</p>
          <form onSubmit={handleSubmit}>
            <div className="space-y-2.5"><label htmlFor="login-username" className="block text-ink-soft">{tr("username")}</label>
              <Input id="login-username" name="username" autoComplete="username" spellCheck={false} autoCapitalize="off" value={username} onChange={event => setUsername(event.target.value)} />
            </div>
            <div className="space-y-2.5"><label htmlFor="login-password" className="block text-ink-soft">{tr("password")}</label>
              <Input id="login-password" name="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-muted"><input type="checkbox" checked={rememberMe} onChange={event => setRememberMe(event.target.checked)} />{tr("remember")}</label>
              <button type="button" onClick={handleOpenResetDialog} className="text-xs text-muted transition hover:text-brand">{tr("forgot")}</button>
            </div>
            <Button type="submit" size="lg" disabled={isDisabled} loading={loading}>{loading ? tr("submitting") : tr("submit")}{!loading && <ArrowUpRight size={18} />}</Button>
          </form>
          <p className="auth-fineprint"><LockKeyhole size={13} aria-hidden="true" />{tr("hint")}</p>
        </div>
      </main>

      {resetDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-0 backdrop-blur-[2px] sm:items-center sm:p-6">
          <div className="animate-rise-in w-full max-w-md overflow-hidden rounded-t-xl border border-line bg-surface shadow-panel sm:rounded-xl">
            <div className="border-b border-line px-5 py-4">
              <h2 className="text-base font-semibold">{tr("resetTitle")}</h2>
            </div>
            <div className="px-5 py-4">
              <p className="text-xs leading-relaxed text-ink-soft">{tr("resetBody")}</p>
              <pre className="mt-3 overflow-x-auto rounded-md border border-line bg-canvas px-3 py-2 font-mono text-[11px] text-ink-soft">
                <code>{resetCommand}</code>
              </pre>
              <p className="mt-3 text-2xs text-muted">{tr("resetHint")}</p>
            </div>
            <div className="flex justify-end border-t border-line px-5 py-3">
              <Button size="sm" variant="secondary" onClick={() => setResetDialogOpen(false)}>
                {tr("done")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
