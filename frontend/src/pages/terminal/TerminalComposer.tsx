import React from "react";
import { ChevronDown, ChevronUp, Paperclip, Send, X } from "lucide-react";
import { Button } from "../../components/Button";

type Props = {
  connected: boolean;
  t: (zh: string, en: string) => string;
  onFill: (text: string, images?: File[]) => Promise<boolean>;
};

/** Draft keystrokes stay in this component and never rerender the terminal. */
export const TerminalComposer = React.memo(function TerminalComposer({ connected, t, onFill }: Props) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const [images, setImages] = React.useState<File[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const composing = React.useRef(false);
  const submitting = React.useRef(false);
  const alive = React.useRef(true);
  const input = React.useRef<HTMLInputElement>(null);
  const editor = React.useRef<HTMLTextAreaElement>(null);
  const id = React.useId();
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  React.useEffect(() => { if (open) editor.current?.focus(); }, [open]);
  const addImages = (files: File[]) => {
    if (files.some(file => file.size > 20 * 1024 * 1024)) {
      setError(t("图片不能超过 20 MiB", "Images must not exceed 20 MiB"));
      return;
    }
    setError("");
    setImages(current => [...current, ...files.filter(file => file.type.startsWith("image/"))]);
  };
  const fill = async () => {
    if (submitting.current || composing.current || !connected || (!text && !images.length)) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const applied = await onFill(text, images);
      if (applied && alive.current) { setText(""); setImages([]); }
    } catch {
      if (alive.current) setError(t("填入失败，草稿已保留，请重试", "Unable to fill the terminal. Your draft is preserved."));
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return <section className="mx-3 mb-3 shrink-0 overflow-hidden rounded-lg border border-line bg-surface text-ink sm:mx-4 sm:mb-4" aria-label={t("本地输入", "Local draft")}>
    <button type="button" className="flex min-h-9 w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs text-ink-soft hover:bg-elevated"
      aria-expanded={open} aria-controls={id} onClick={() => { composing.current = false; setOpen(value => !value); }}>
      <span>{t("本地输入", "Local draft")}{text || images.length ? <span className="ml-2 text-brand">{t("有草稿", "Draft")}</span> : null}</span>
      {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
    </button>
    {open ? <div id={id} className="border-t border-line p-3">
      <textarea ref={editor} value={text} disabled={busy} rows={4} aria-label={t("本地描述输入框", "Local description")}
        placeholder={t("在本地编辑描述，支持中文、多行文字和粘贴截图…", "Write locally. Chinese, multiline text and pasted screenshots are supported…")}
        className="block max-h-[30vh] min-h-20 w-full resize-y rounded-md border border-line bg-canvas p-2 text-sm text-ink outline-none focus:border-brand disabled:opacity-60"
        onChange={event => setText(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return;
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void fill(); }
        }}
        onPaste={event => {
          const files = Array.from(event.clipboardData.items).filter(item => item.kind === "file" && item.type.startsWith("image/"))
            .map(item => item.getAsFile()).filter((file): file is File => file !== null);
          if (files.length) { event.preventDefault(); addImages(files); }
        }} />
      {images.length ? <div className="mt-2 flex max-h-20 flex-wrap gap-2 overflow-y-auto" aria-label={t("待发送图片", "Attached images")}>
        {images.map((file, index) => <span key={index} className="inline-flex max-w-full items-center gap-1 rounded border border-line bg-elevated px-2 py-1 text-xs">
          <span className="truncate">{file.name || t(`图片 ${index + 1}`, `Image ${index + 1}`)}</span>
          <button type="button" disabled={busy} onClick={() => setImages(current => current.filter((_, position) => position !== index))}
            aria-label={t(`移除图片 ${index + 1}`, `Remove image ${index + 1}`)}><X className="h-3.5 w-3.5" /></button>
        </span>)}
      </div> : null}
      {error ? <p role="alert" className="mt-2 text-xs text-danger">{error}</p> : null}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-full text-2xs text-muted">{connected
          ? t("Enter 换行 · Ctrl/⌘+Enter 填入 · 在终端按 Enter 提交", "Enter: new line · Ctrl/⌘+Enter: fill · Press Enter in the terminal to submit")
          : t("终端未连接，草稿保留在本页", "Disconnected. Your draft stays on this page.")}</p>
        <div className="ml-auto flex items-center gap-2">
          <input ref={input} type="file" multiple accept="image/*" className="hidden" aria-label={t("选择图片", "Choose images")}
            onChange={event => { addImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => input.current?.click()} aria-label={t("添加图片", "Attach images")}><Paperclip className="h-3.5 w-3.5" /></Button>
          <Button size="sm" loading={busy} disabled={!connected || (!text && !images.length)} onClick={() => void fill()}>
            <Send className="h-3.5 w-3.5" />{t("填入终端", "Fill terminal")}
          </Button>
        </div>
      </div>
    </div> : null}
  </section>;
});
