import React from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/Button";
import { Brand } from "../components/Brand";
import { SignalArtwork } from "../components/SignalArtwork";
import { useApp } from "../context/AppContextCore";
import { ArrowUpRight, LockKeyhole } from "lucide-react";
import { Input } from "../components/Input";
import { useToast } from "../components/ToastContext";
import { changePassword, clearAuthStorage } from "../lib/api";

export function ForcePasswordChange() {
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const navigate = useNavigate();
  const { push } = useToast();
  const { language } = useApp();
  const t = (zh: string, en: string) => language === "en-US" ? en : zh;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      await changePassword(currentPassword, newPassword, confirmPassword);
      push(t("密码已更新，请重新登录", "Password updated. Please sign in again."));
      clearAuthStorage();
      navigate("/");
    } catch (error) {
      push(error instanceof Error ? error.message : t("修改失败", "Password update failed"));
    } finally {
      setLoading(false);
    }
  };

  const isDisabled = !currentPassword || !newPassword || !confirmPassword || loading;

  return (
    <main className="password-page">
      <SignalArtwork />
      <section className="password-card ui-card border border-line bg-surface">
        <Brand />
        <p className="eyebrow mt-7"><span>02</span> / ACCOUNT ACCESS</p>
        <h1>{t("为工作空间，加一道锁。", "Make this space yours.")}</h1>
        <p className="text-xs leading-6 text-muted">{t("首次登录请修改密码。至少 8 位，包含大小写字母和数字。", "Choose a new password before continuing: at least 8 characters, including uppercase, lowercase and numbers.")}</p>
        <form className="space-y-5" onSubmit={handleSubmit}>
          {[
            { id: "password-current", label: t("当前密码", "Current password"), value: currentPassword, change: setCurrentPassword, autoComplete: "current-password" },
            { id: "password-new", label: t("新密码", "New password"), value: newPassword, change: setNewPassword, autoComplete: "new-password" },
            { id: "password-confirm", label: t("确认新密码", "Confirm password"), value: confirmPassword, change: setConfirmPassword, autoComplete: "new-password" },
          ].map(field => <div key={field.id} className="space-y-2"><label htmlFor={field.id} className="text-xs text-ink-soft">{field.label}</label><Input id={field.id} type="password" autoComplete={field.autoComplete} value={field.value} onChange={event => field.change(event.target.value)} /></div>)}
          <Button disabled={isDisabled} loading={loading} type="submit" className="h-11 w-full justify-between">{t("更新密码", "Update password")}<ArrowUpRight size={17} /></Button>
        </form>
        <p className="mt-5 flex items-center gap-2 text-2xs text-muted"><LockKeyhole size={12} />{t("更新后将返回登录页面。", "You will return to sign in after updating.")}</p>
      </section>
    </main>
  );
}
