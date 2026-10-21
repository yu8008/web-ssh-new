import React from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Moon, Sun, Terminal } from "lucide-react";
import { Button } from "../components/Button";
import { Input } from "../components/Input";
import { useToast } from "../components/ToastContext";
import { useApp } from "../context/AppContextCore";
import { login, storeAuthData } from "../lib/api";
import { parseJwt } from "../lib/auth";

const copy = {
  title: { zh: "登录工作台", en: "Sign in" },
  subtitle: { zh: "用管理员账号进入 WebSSH 工作台", en: "Use your admin account to open the workbench" },
  username: { zh: "用户名", en: "Username" },
  password: { zh: "密码", en: "Password" },
  remember: { zh: "记住我", en: "Keep me signed in" },
  submit: { zh: "登录", en: "Sign in" },
  submitting: { zh: "正在登录…", en: "Signing in…" },
  forgot: { zh: "忘记密码？", en: "Forgot password?" },
  hint: { zh: "首次部署：初始密码来自 .env 的 INITIAL_ADMIN_PASSWORD。", en: "First run: the initial password comes from INITIAL_ADMIN_PASSWORD." },
  headline: { zh: "服务器，就在这个标签页里。", en: "Your servers, in one tab." },
  lead: {
    zh: "保存连接、启动持久会话、翻看文件，不用再在多个终端窗口之间切换。",
    en: "Save connections, keep sessions alive and move files without switching terminal windows.",
  },
  features: [
    { zh: "断网或关掉浏览器，会话仍在后台运行", en: "Sessions keep running after you close the browser" },
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
    <div className="flex min-h-screen bg-canvas text-ink">
      <aside className="relative hidden w-[46%] max-w-[620px] flex-col justify-between overflow-hidden border-r border-line bg-surface px-10 py-10 lg:flex">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_80%_at_10%_0%,rgb(var(--brand)/0.14),transparent_55%)]" />
        <div className="relative flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand/12 text-brand ring-1 ring-inset ring-brand/25">
            <Terminal className="h-4 w-4" />
          </span>
          <span className="text-sm font-semibold tracking-tight">WebSSH</span>
          <span className="rounded border border-line px-1.5 py-0.5 text-[10px] font-medium text-muted">Gateway</span>
        </div>

        <div className="relative max-w-md">
          <h1 className="text-2xl font-semibold leading-tight tracking-tight">{tr("headline")}</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-soft">{tr("lead")}</p>
          <ul className="mt-8 space-y-3">
            {copy.features.map((feature) => (
              <li key={feature.zh} className="flex items-start gap-2.5 text-xs text-muted">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand/70" />
                {zh ? feature.zh : feature.en}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative rounded-lg border border-line bg-canvas/80 p-4 font-mono text-xs backdrop-blur">
          <div className="flex items-center gap-1.5 text-muted">
            <span className="h-2 w-2 rounded-full bg-ok/80" />
            <span className="h-2 w-2 rounded-full bg-warn/70" />
            <span className="h-2 w-2 rounded-full bg-line-strong" />
            <span className="ml-2 text-[10px] uppercase tracking-wide">session</span>
          </div>
          <div className="mt-3 space-y-1.5">
            <div className="text-ink-soft">
              <span className="text-brand">$</span> ssh ops@10.0.12.8
            </div>
            <div className="text-muted">connected · tmux keep-alive · 2h 14m</div>
          </div>
        </div>
      </aside>

      <main className="relative flex flex-1 items-center justify-center px-5 py-10">
        <div className="absolute right-4 top-4 flex items-center gap-1">
          <button
            type="button"
            onClick={toggleLanguage}
            className="grid h-8 min-w-8 place-items-center rounded-md px-2 text-2xs font-semibold text-muted transition hover:bg-elevated hover:text-ink"
            aria-label={zh ? "Switch to English" : "切换到中文"}
          >
            {zh ? "EN" : "中"}
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            className="grid h-8 w-8 place-items-center rounded-md text-muted transition hover:bg-elevated hover:text-ink"
            aria-label={zh ? "切换主题" : "Toggle theme"}
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>

        <div className="animate-rise-in w-full max-w-[360px]">
          <div className="mb-6 flex items-center gap-2 lg:hidden">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-brand/12 text-brand ring-1 ring-inset ring-brand/25">
              <Terminal className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold">WebSSH</span>
          </div>
          <h2 className="text-xl font-semibold tracking-tight">{tr("title")}</h2>
          <p className="mt-1 text-xs text-muted">{tr("subtitle")}</p>

          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-1.5">
              <label htmlFor="login-username" className="block text-xs font-medium text-soft">
                {tr("username")}
              </label>
              <Input
                id="login-username"
                name="username"
                autoComplete="username"
                spellCheck={false}
                autoCapitalize="off"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="login-password" className="block text-xs font-medium text-soft">
                {tr("password")}
              </label>
              <Input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-line accent-[rgb(var(--brand))]"
                  checked={rememberMe}
                  onChange={(event) => setRememberMe(event.target.checked)}
                />
                {tr("remember")}
              </label>
              <button type="button" onClick={handleOpenResetDialog} className="text-xs text-muted transition hover:text-brand">
                {tr("forgot")}
              </button>
            </div>

            <Button type="submit" size="lg" className="w-full" disabled={isDisabled} loading={loading}>
              {loading ? tr("submitting") : tr("submit")}
              {!loading ? <ArrowRight className="h-4 w-4" /> : null}
            </Button>
          </form>

          <p className="mt-5 text-2xs leading-relaxed text-muted">{tr("hint")}</p>
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
