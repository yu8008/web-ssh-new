import React from "react";
import { X, KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import type { SessionsState } from "./useSessionsState";

type ConnectionDialogProps = {
  state: SessionsState;
};

export function ConnectionDialog({ state }: ConnectionDialogProps) {
  const editing = state.editingConnection;
  const open = state.showCreateForm || Boolean(editing);
  const form = editing ? state.editForm : state.form;
  const setForm = editing ? state.setEditForm : state.setForm;
  const title = editing ? state.t("编辑连接", "Edit connection") : state.t("新建连接", "New connection");
  const submitLabel = editing ? state.t("保存修改", "Save changes") : state.t("保存连接", "Save connection");
  const nameId = React.useId();
  const hostId = React.useId();
  const portId = React.useId();
  const userFieldId = React.useId();
  const secretId = React.useId();
  const passphraseId = React.useId();

  const close = React.useCallback(() => {
    if (editing) {
      state.setEditingConnection(null);
    } else {
      state.setShowCreateForm(false);
    }
  }, [editing, state]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, close]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[110] flex items-end justify-center bg-black/55 backdrop-blur-[2px] sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          close();
        }
      }}
    >
      <form
        onSubmit={editing ? state.handleUpdateConnection : state.handleCreateConnection}
        className="animate-rise-in flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-xl border border-line bg-surface shadow-panel sm:rounded-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">{title}</h2>
            <p className="mt-0.5 text-xs text-muted">
              {state.t("凭据加密保存在服务端，只在使用时解密。", "Credentials are encrypted at rest and only decrypted when needed.")}
            </p>
          </div>
          <Button variant="ghost" size="icon" type="button" onClick={close} aria-label={state.t("关闭", "Close")}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_92px]">
            <Field label={state.t("名称", "Name")} htmlFor={nameId}>
              <Input
                id={nameId}
                autoFocus
                required
                placeholder={state.t("例如：生产 Web", "Example: production web")}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </Field>
            <Field label={state.t("端口", "Port")} htmlFor={portId}>
              <Input
                id={portId}
                type="number"
                min={1}
                max={65535}
                required
                value={form.port}
                onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
              />
            </Field>
          </div>

          <Field label={state.t("主机", "Host")} htmlFor={hostId}>
            <Input
              id={hostId}
              required
              spellCheck={false}
              autoCapitalize="off"
              className="font-mono"
              placeholder="10.0.12.8"
              value={form.host}
              onChange={(event) => setForm({ ...form, host: event.target.value })}
            />
          </Field>

          <Field label={state.t("用户名", "Username")} htmlFor={userFieldId}>
            <Input
              id={userFieldId}
              required
              spellCheck={false}
              autoCapitalize="off"
              className="font-mono"
              placeholder="root"
              value={form.username}
              onChange={(event) => setForm({ ...form, username: event.target.value })}
            />
          </Field>

          <div>
            <span className="mb-1.5 block text-xs font-medium text-soft">{state.t("认证方式", "Authentication")}</span>
            <div className="grid grid-cols-2 gap-1 rounded-md border border-line bg-canvas p-1" role="group">
              {[
                { value: "password" as const, label: state.t("密码", "Password"), Icon: ShieldCheck },
                { value: "private_key" as const, label: state.t("私钥", "Private key"), Icon: KeyRound },
              ].map((option) => {
                const active = form.auth_type === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setForm({ ...form, auth_type: option.value })}
                    className={
                      "flex h-8 items-center justify-center gap-1.5 rounded text-xs font-medium transition " +
                      (active ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink")
                    }
                  >
                    <option.Icon className="h-3.5 w-3.5" />
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          {form.auth_type === "password" ? (
            <Field
              label={editing ? state.t("新密码（留空则不修改）", "New password (leave blank to keep)") : state.t("密码", "Password")}
              htmlFor={secretId}
            >
              <Input
                id={secretId}
                type="password"
                required={!editing}
                autoComplete="new-password"
                placeholder="••••••••"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
              />
            </Field>
          ) : (
            <>
              <Field
                label={editing ? state.t("新私钥（留空则不修改）", "New private key (leave blank to keep)") : state.t("私钥", "Private key")}
                htmlFor={secretId}
              >
                <textarea
                  id={secretId}
                  spellCheck={false}
                  required={!editing}
                  value={form.private_key}
                  onChange={(event) => setForm({ ...form, private_key: event.target.value })}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  className="h-28 w-full resize-none rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs text-ink placeholder:text-muted/70 focus:border-brand/70 focus:outline-none focus:ring-2 focus:ring-brand/25"
                />
              </Field>
              <Field label={state.t("私钥密码（可选）", "Key passphrase (optional)")} htmlFor={passphraseId}>
                <Input
                  id={passphraseId}
                  type="password"
                  value={form.key_passphrase}
                  onChange={(event) => setForm({ ...form, key_passphrase: event.target.value })}
                />
              </Field>
            </>
          )}

          <p className="flex items-start gap-2 rounded-md border border-line bg-canvas px-3 py-2 text-xs text-muted">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {state.t(
              "运行本服务的机器需要能访问到目标主机。",
              "The machine running this service must be able to reach the target host."
            )}
          </p>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
          <span className="text-2xs text-muted">Esc {state.t("关闭", "to close")}</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" type="button" onClick={close}>
              {state.t("取消", "Cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={editing ? false : state.connectingId !== null}>
              {submitLabel}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-soft">
        {label}
      </label>
      {children}
    </div>
  );
}
