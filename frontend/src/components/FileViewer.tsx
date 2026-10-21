import React from "react";
import { Download, FileCode2, FileText, Image as ImageIcon, Loader2, Pencil, Save, X } from "lucide-react";
import { downloadFile, readFile, writeFile } from "../lib/api";
import { useApp } from "../context/AppContextCore";
import { useToast } from "./ToastContext";

type FileViewerProps = {
  sessionId: string;
  path: string;
  isDark: boolean;
  onClose: () => void;
};

type PreviewKind = "text" | "image" | "pdf" | "binary";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif", "tif", "tiff"]);
const BINARY_EXTENSIONS = new Set([
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "jar", "war", "apk", "deb", "rpm",
  "exe", "dll", "so", "dylib", "bin", "iso", "img", "mp3", "mp4", "mkv", "avi", "mov", "wav", "flac",
  "woff", "woff2", "ttf", "otf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "db", "sqlite", "class",
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  json: "json", jsonc: "json",
  py: "python", sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", conf: "ini", env: "ini",
  go: "go", rs: "rust", java: "java", kt: "kotlin", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp",
  cs: "csharp", php: "php", rb: "ruby", sql: "sql", html: "html", htm: "html", xml: "xml",
  css: "css", scss: "css", less: "css", md: "markdown", markdown: "markdown", vue: "html",
};

const KEYWORDS: Record<string, string[]> = {
  javascript: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "new", "await", "async", "import", "from", "export", "default", "try", "catch", "finally", "throw", "typeof", "instanceof", "this", "null", "undefined", "true", "false"],
  typescript: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "interface", "type", "enum", "extends", "implements", "public", "private", "protected", "readonly", "new", "await", "async", "import", "from", "export", "default", "try", "catch", "finally", "throw", "as", "null", "undefined", "true", "false"],
  python: ["def", "class", "return", "if", "elif", "else", "for", "while", "import", "from", "as", "try", "except", "finally", "raise", "with", "lambda", "yield", "async", "await", "pass", "None", "True", "False", "and", "or", "not", "in", "is"],
  bash: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "return", "export", "local", "echo", "cd", "sudo", "exit"],
  go: ["package", "import", "func", "return", "if", "else", "for", "range", "type", "struct", "interface", "map", "chan", "go", "defer", "nil", "true", "false", "var", "const"],
  rust: ["fn", "let", "mut", "pub", "use", "mod", "struct", "enum", "impl", "trait", "match", "if", "else", "for", "while", "loop", "return", "self", "Self", "Some", "None", "Ok", "Err", "async", "await", "move", "const"],
  java: ["public", "private", "protected", "class", "interface", "extends", "implements", "static", "final", "void", "int", "long", "double", "float", "boolean", "char", "String", "new", "return", "if", "else", "for", "while", "try", "catch", "finally", "throw", "import", "package", "null", "true", "false"],
  c: ["int", "char", "float", "double", "void", "struct", "union", "enum", "typedef", "static", "const", "return", "if", "else", "for", "while", "switch", "case", "break", "continue", "sizeof", "include", "define", "NULL"],
  cpp: ["int", "char", "float", "double", "void", "class", "struct", "namespace", "template", "typename", "public", "private", "protected", "const", "static", "return", "if", "else", "for", "while", "new", "delete", "nullptr", "using", "auto"],
  json: ["true", "false", "null"],
  yaml: ["true", "false", "null"],
  sql: ["select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create", "table", "alter", "drop", "join", "left", "right", "inner", "outer", "on", "group", "by", "order", "limit", "offset", "and", "or", "not", "null", "as"],
  ini: ["true", "false"],
  csharp: ["public", "private", "protected", "class", "struct", "interface", "static", "void", "int", "string", "bool", "var", "new", "return", "if", "else", "for", "foreach", "while", "try", "catch", "finally", "namespace", "using", "null", "true", "false"],
  php: ["function", "class", "public", "private", "protected", "static", "return", "if", "else", "elseif", "foreach", "for", "while", "echo", "new", "null", "true", "false", "use", "namespace"],
  ruby: ["def", "class", "module", "end", "if", "else", "elsif", "do", "while", "return", "nil", "true", "false", "require", "include"],
  kotlin: ["fun", "val", "var", "class", "object", "interface", "if", "else", "for", "while", "return", "when", "null", "true", "false", "import", "package"],
};

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function extensionOf(path: string): string {
  const clean = path.split("?")[0].split("#")[0];
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  const name = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function baseName(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function previewKindOf(path: string): PreviewKind {
  const ext = extensionOf(path);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (BINARY_EXTENSIONS.has(ext)) return "binary";
  return "text";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, index);
  return (index === 0 ? String(Math.round(value)) : value.toFixed(1)) + " " + units[index];
}

function escapeRegExp(value: string): string {
  return value.replace(/[*+?^$()|[\]\\]/g, "\\$&");
}

const MAX_HIGHLIGHT_CHARS = 200000;

/** 轻量高亮：只处理注释 / 字符串 / 数字 / 关键字，够读代码即可。 */
function highlightLine(line: string, language: string): React.ReactNode {
  const keywords = KEYWORDS[language] ?? [];
  const commentPrefix = ["python", "bash", "yaml", "ini", "ruby"].includes(language) ? "#" : "//";
  const source =
    "(" + escapeRegExp(commentPrefix) + "[^\\n]*)" +
    "|(\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*')" +
    "|(\\b\\d+(?:\\.\\d+)?\\b)" +
    (keywords.length > 0 ? "|\\b(" + keywords.map(escapeRegExp).join("|") + ")\\b" : "");
  const pattern = new RegExp(source, "g");
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(line.slice(lastIndex, match.index));
    }
    const text = match[0];
    const className = match[1]
      ? "text-slate-500 italic"
      : match[2]
        ? "text-emerald-300"
        : match[3]
          ? "text-amber-300"
          : "text-sky-300";
    nodes.push(
      <span key={match.index + "-" + text} className={className}>
        {text}
      </span>
    );
    lastIndex = match.index + text.length;
    if (text.length === 0) {
      pattern.lastIndex += 1;
    }
  }
  if (lastIndex < line.length) {
    nodes.push(line.slice(lastIndex));
  }
  return nodes;
}

export function FileViewer({ sessionId, path, isDark, onClose }: FileViewerProps) {
  const { language } = useApp();
  const { push } = useToast();
  const t = React.useCallback(
    (zh: string, en: string) => (language === "en-US" ? en : zh),
    [language]
  );

  const kind = React.useMemo(() => previewKindOf(path), [path]);
  const fileName = React.useMemo(() => baseName(path), [path]);
  const fileLanguage = React.useMemo(() => LANGUAGE_BY_EXTENSION[extensionOf(path)] ?? "text", [path]);

  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [text, setText] = React.useState("");
  const [originalText, setOriginalText] = React.useState("");
  const [size, setSize] = React.useState(0);
  const [tooLarge, setTooLarge] = React.useState(false);
  const [binary, setBinary] = React.useState(kind === "binary");
  const [mediaUrl, setMediaUrl] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const mediaUrlRef = React.useRef<string | null>(null);

  const dirty = text !== originalText;

  const requestClose = React.useCallback(() => {
    if (dirty && !window.confirm(t("有未保存的修改，确定关闭？", "You have unsaved changes. Close anyway?"))) {
      return;
    }
    onClose();
  }, [dirty, onClose, t]);

  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        requestClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [requestClose]);

  const load = React.useCallback(
    async (force: boolean) => {
      setLoading(true);
      setError(null);
      try {
        if (kind === "binary") {
          setBinary(true);
          setLoading(false);
          return;
        }
        if (kind === "image" || kind === "pdf") {
          const blob = await downloadFile(sessionId, path);
          const typed = new Blob([blob], {
            type: kind === "pdf" ? "application/pdf" : blob.type || "application/octet-stream",
          });
          if (mediaUrlRef.current) {
            URL.revokeObjectURL(mediaUrlRef.current);
          }
          const url = URL.createObjectURL(typed);
          mediaUrlRef.current = url;
          setMediaUrl(url);
          setSize(blob.size);
          return;
        }
        const result = await readFile(sessionId, path, force);
        setSize(result.size);
        if (result.too_large) {
          setTooLarge(true);
          setText("");
          setOriginalText("");
          return;
        }
        const content = result.content ?? "";
        const looksBinary = content.indexOf("\u0000") >= 0;
        setBinary(looksBinary);
        setTooLarge(false);
        setText(content);
        setOriginalText(content);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("读取文件失败", "Failed to read file"));
      } finally {
        setLoading(false);
      }
    },
    [kind, path, sessionId, t]
  );

  React.useEffect(() => {
    setEditing(false);
    setTooLarge(false);
    setBinary(kind === "binary");
    if (mediaUrlRef.current) {
      URL.revokeObjectURL(mediaUrlRef.current);
      mediaUrlRef.current = null;
    }
    setMediaUrl(null);
    void load(false);
  }, [kind, load]);

  React.useEffect(() => {
    return () => {
      if (mediaUrlRef.current) {
        URL.revokeObjectURL(mediaUrlRef.current);
        mediaUrlRef.current = null;
      }
    };
  }, []);

  const handleSave = React.useCallback(async () => {
    setSaving(true);
    try {
      await writeFile(sessionId, path, text);
      setOriginalText(text);
      push(t("已保存", "Saved"));
    } catch (err) {
      push(err instanceof Error ? err.message : t("保存失败", "Save failed"));
    } finally {
      setSaving(false);
    }
  }, [path, push, sessionId, t, text]);

  const handleDownload = React.useCallback(async () => {
    setDownloading(true);
    try {
      const blob = await downloadFile(sessionId, path);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      push(err instanceof Error ? err.message : t("下载失败", "Download failed"));
    } finally {
      setDownloading(false);
    }
  }, [fileName, path, push, sessionId, t]);

  const allLines = React.useMemo(() => text.split("\n"), [text]);
  const maxRenderedLines = 5000;
  const lines = allLines.length > maxRenderedLines ? allLines.slice(0, maxRenderedLines) : allLines;
  const highlightable = text.length <= MAX_HIGHLIGHT_CHARS;

  const HeaderIcon = kind === "image" ? ImageIcon : kind === "text" ? FileCode2 : FileText;
  const kindLabel =
    kind === "image"
      ? t("图片预览", "Image")
      : kind === "pdf"
        ? "PDF"
        : binary
          ? t("二进制文件", "Binary")
          : fileLanguage === "text"
            ? t("文本文件", "Text")
            : fileLanguage.toUpperCase();
  const meta = [path, formatBytes(size || text.length), kindLabel].join("  ·  ");

  const secondaryButton = cx(
    "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs",
    isDark
      ? "border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
  );

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-2 backdrop-blur-sm sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("文件查看器", "File viewer")}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          requestClose();
        }
      }}
    >
      <div
        className={cx(
          "flex h-full max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border shadow-2xl",
          isDark ? "border-slate-700 bg-slate-950 text-slate-100" : "border-slate-200 bg-white text-slate-900"
        )}
      >
        <div className={cx("flex items-start gap-3 border-b px-4 py-3", isDark ? "border-slate-800" : "border-slate-200")}>
          <div className={cx("mt-0.5 rounded-md p-1.5", isDark ? "bg-slate-800 text-indigo-300" : "bg-slate-100 text-indigo-600")}>
            <HeaderIcon className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{fileName}</span>
              {dirty ? (
                <span
                  className={cx(
                    "rounded-full px-2 py-0.5 text-[10px]",
                    isDark ? "bg-amber-500/15 text-amber-300" : "bg-amber-100 text-amber-700"
                  )}
                >
                  {t("未保存", "Unsaved")}
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-slate-500" title={meta}>
              {meta}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {kind === "text" && !tooLarge && !binary && !error ? (
              <button type="button" onClick={() => setEditing((value) => !value)} className={secondaryButton}>
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                {editing ? t("退出编辑", "Exit edit") : t("编辑", "Edit")}
              </button>
            ) : null}
            {dirty ? (
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-indigo-500 px-2.5 text-xs font-medium text-white hover:bg-indigo-400 disabled:opacity-60"
              >
                <Save className="h-3.5 w-3.5" aria-hidden="true" />
                {t("保存", "Save")}
              </button>
            ) : null}
            <button type="button" onClick={() => void handleDownload()} disabled={downloading} className={secondaryButton}>
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {t("下载", "Download")}
            </button>
            <button
              type="button"
              onClick={requestClose}
              className={cx(
                "inline-flex h-8 w-8 items-center justify-center rounded-md border",
                isDark
                  ? "border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
                  : "border-slate-300 bg-white text-slate-600 hover:bg-slate-100"
              )}
              aria-label={t("关闭", "Close")}
              title={t("关闭 (Esc)", "Close (Esc)")}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className={cx("relative min-h-0 flex-1", isDark ? "bg-slate-950" : "bg-slate-50")}>
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t("加载中...", "Loading...")}
            </div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <p className={cx("text-sm", isDark ? "text-rose-300" : "text-rose-600")}>{error}</p>
              <button
                type="button"
                onClick={() => void load(false)}
                className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs text-white hover:bg-indigo-400"
              >
                {t("重试", "Retry")}
              </button>
            </div>
          ) : kind === "image" && mediaUrl ? (
            <div className="flex h-full items-center justify-center p-6">
              <img src={mediaUrl} alt={fileName} className="max-h-full max-w-full object-contain" />
            </div>
          ) : kind === "pdf" && mediaUrl ? (
            <iframe src={mediaUrl} title={fileName} className="h-full w-full" />
          ) : tooLarge ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <FileText className="h-8 w-8 text-slate-500" aria-hidden="true" />
              <p className={cx("text-sm", isDark ? "text-slate-300" : "text-slate-600")}>
                {t(
                  "文件较大 (" + formatBytes(size) + ")，超过 1 MB 的默认限制",
                  "File is large (" + formatBytes(size) + "), above the 1 MB default limit"
                )}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void load(true)}
                  className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs text-white hover:bg-indigo-400"
                >
                  {t("仍然加载", "Load anyway")}
                </button>
                <button type="button" onClick={() => void handleDownload()} className={secondaryButton}>
                  {t("下载", "Download")}
                </button>
              </div>
            </div>
          ) : binary ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <FileText className="h-8 w-8 text-slate-500" aria-hidden="true" />
              <p className={cx("text-sm", isDark ? "text-slate-300" : "text-slate-600")}>
                {t("该文件是二进制内容，无法以文本预览", "This file looks binary and cannot be previewed as text")}
              </p>
              <button
                type="button"
                onClick={() => void handleDownload()}
                className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs text-white hover:bg-indigo-400"
              >
                {t("下载", "Download")}
              </button>
            </div>
          ) : editing ? (
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              spellCheck={false}
              className={cx(
                "h-full w-full resize-none bg-transparent p-4 font-mono text-[13px] leading-[1.55] outline-none",
                isDark ? "text-slate-200" : "text-slate-800"
              )}
            />
          ) : (
            <div className="h-full overflow-auto">
              <div className="min-w-max pb-4 font-mono text-[13px] leading-[1.55]">
                {lines.map((line, index) => (
                  <div key={index} className="flex">
                    <span
                      className={cx(
                        "sticky left-0 w-12 shrink-0 select-none border-r px-2 text-right text-[11px]",
                        isDark
                          ? "border-slate-800 bg-slate-950 text-slate-600"
                          : "border-slate-200 bg-slate-50 text-slate-400"
                      )}
                    >
                      {index + 1}
                    </span>
                    <span className={cx("whitespace-pre px-3", isDark ? "text-slate-200" : "text-slate-800")}>
                      {highlightable && line ? highlightLine(line, fileLanguage) : line || " "}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div
          className={cx(
            "flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-[11px]",
            isDark ? "border-slate-800 text-slate-500" : "border-slate-200 text-slate-500"
          )}
        >
          <div className="flex flex-wrap items-center gap-3">
            <span>UTF-8</span>
            {kind === "text" && !tooLarge && !binary ? (
              <span>
                {allLines.length > lines.length
                  ? t("显示前 " + lines.length + " / 共 " + allLines.length + " 行", "Showing " + lines.length + " of " + allLines.length + " lines")
                  : t(allLines.length + " 行", allLines.length + " lines")}
              </span>
            ) : null}
            <span>{formatBytes(size || text.length)}</span>
          </div>
          <span className="hidden sm:inline">{t("Esc 关闭", "Esc to close")}</span>
        </div>
      </div>
    </div>
  );
}
