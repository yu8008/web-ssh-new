import React from "react";
import { useApp } from "../context/AppContextCore";
import {
  cleanClipboardCache, deleteClipboardCacheImages, getClipboardCache, listConnections, readClipboardCacheImage,
  type ClipboardCacheImage, type ClipboardCacheInventory, type Connection,
} from "../lib/api";
import { Button } from "./Button";
import { Card } from "./Card";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./ToastContext";

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export function ClipboardImageCache() {
  const { language, isDark, systemSettings } = useApp();
  const { push } = useToast();
  const t = (zh: string, en: string) => language === "en-US" ? en : zh;
  const [connections, setConnections] = React.useState<Connection[]>([]);
  const [connectionId, setConnectionId] = React.useState<number | null>(null);
  const [connectionsLoading, setConnectionsLoading] = React.useState(true);
  const [inventory, setInventory] = React.useState<ClipboardCacheInventory | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [offset, setOffset] = React.useState(0);
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);
  const [deleting, setDeleting] = React.useState<ClipboardCacheImage | null>(null);
  const [preview, setPreview] = React.useState<ClipboardCacheImage | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState("");
  const retentionDays = systemSettings?.clipboard_image_retention_days ?? 3;

  React.useEffect(() => {
    let active = true;
    listConnections().then((items) => {
      if (!active) return;
      setConnections(items);
      setConnectionId(items[0]?.id ?? null);
    }).catch((reason) => {
      if (active) setError(String(reason instanceof Error ? reason.message : reason));
    }).finally(() => { if (active) setConnectionsLoading(false); });
    return () => { active = false; };
  }, []);

  React.useEffect(() => {
    if (connectionId === null) return;
    const controller = new AbortController();
    setLoading(true);
    setInventory(null);
    setError("");
    getClipboardCache(connectionId, offset, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (offset > 0 && offset >= result.total_count) {
        setOffset(Math.max(0, Math.floor((result.total_count - 1) / 20) * 20));
      } else {
        setInventory(result);
      }
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(String(reason instanceof Error ? reason.message : reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [connectionId, offset, revision, retentionDays]);

  React.useEffect(() => {
    setPreviewUrl("");
    if (!preview || connectionId === null) return;
    const controller = new AbortController();
    let objectUrl = "";
    readClipboardCacheImage(connectionId, preview.id, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setPreviewUrl(objectUrl);
    }).catch((reason) => {
      if (!controller.signal.aborted) {
        push(reason instanceof Error ? reason.message : String(reason));
        setPreview(null);
      }
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [preview, connectionId, push]);

  const cleanExpired = async () => {
    if (connectionId === null) return;
    setBusy(true);
    try {
      const result = await cleanClipboardCache(connectionId);
      push(t(`已清理 ${result.deleted} 张图片，释放 ${formatBytes(result.freed_bytes)}`, `Removed ${result.deleted} images, freeing ${formatBytes(result.freed_bytes)}.`));
      setPreview(null);
      refresh();
    } catch (reason) {
      push(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  const deleteImage = async () => {
    if (!deleting || connectionId === null) return;
    setBusy(true);
    try {
      await deleteClipboardCacheImages(connectionId, [deleting.id]);
      if (preview?.id === deleting.id) setPreview(null);
      setDeleting(null);
      refresh();
    } catch (reason) {
      push(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  return (
    <Card
      title={t("临时图片缓存", "Temporary Image Cache")}
      description={t("管理通过 WebSSH Gateway 粘贴的图片。图片保存在所选 SSH 服务器，同一远程账号的连接共享缓存，包含旧版上传的临时图片。", "Manage images pasted through WebSSH Gateway, including older uploads. Images live on the selected SSH server; connections to the same remote account share this cache.")}
      className={!isDark ? "bg-white border-slate-200 shadow-sm" : ""}
      titleClassName={!isDark ? "text-slate-900" : ""}
      descClassName={!isDark ? "text-slate-500" : ""}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
            <label htmlFor="clipboard-cache-connection" className="text-sm">{t("SSH 连接", "SSH connection")}</label>
            <select
              id="clipboard-cache-connection"
              value={connectionId ?? ""}
              disabled={busy || connectionsLoading || connections.length === 0}
              onChange={(event) => { setPreview(null); setOffset(0); setConnectionId(Number(event.target.value)); }}
              className="mt-2 block w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
            >
              {connections.length === 0 && <option value="">{connectionsLoading ? t("加载中...", "Loading...") : t("暂无连接", "No connections")}</option>}
              {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name} · {connection.username}@{connection.host}</option>)}
            </select>
          </div>
          <Button variant="secondary" disabled={busy || loading || connectionId === null} onClick={refresh}>{t("刷新缓存", "Refresh cache")}</Button>
          <Button variant="secondary" loading={busy} disabled={loading || !inventory?.expired_count} onClick={() => void cleanExpired()}>{t("清理过期图片", "Clean expired images")}</Button>
        </div>
        <p className="text-xs text-muted">{t(`当前保留 ${retentionDays} 天，后台每小时检查。目标离线期间暂缓清理，恢复连接后自动重试。`, `Images are kept for ${retentionDays} days and checked hourly. Offline targets are retried when reachable.`)}</p>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {loading && <p role="status" className="text-sm text-muted">{t("正在读取远程缓存...", "Reading remote cache...")}</p>}
        {inventory && <>
          <p className="text-sm text-ink-soft">{t(`共 ${inventory.total_count} 张 · 占用 ${formatBytes(inventory.total_bytes)} · 已过期 ${inventory.expired_count} 张`, `${inventory.total_count} images · ${formatBytes(inventory.total_bytes)} used · ${inventory.expired_count} expired`)}</p>
          {inventory.total_count === 0 ? <p className="py-4 text-sm text-muted">{t("暂无粘贴图片缓存", "No pasted images cached")}</p> : <>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-left text-sm">
                <thead className="bg-elevated text-muted"><tr>
                  <th className="px-3 py-2 font-medium">{t("图片 / 大小", "Image / size")}</th>
                  <th className="px-3 py-2 font-medium">{t("上传 / 到期时间", "Uploaded / expires")}</th>
                  <th className="px-3 py-2 font-medium">{t("操作", "Actions")}</th>
                </tr></thead>
                <tbody>{inventory.images.map((image) => <tr key={image.id} className="border-t border-line">
                  <td className="px-3 py-3"><span className="block font-mono text-xs" title={image.path}>{image.id}</span><span className="text-xs text-muted">{formatBytes(image.size)}</span></td>
                  <td className="px-3 py-3 text-xs"><span className="block whitespace-nowrap">{new Date(image.created_at).toLocaleString(language)}</span><span className={image.expired ? "text-warn" : "text-muted"}>{image.expired ? t("已过期，等待清理", "Expired, awaiting cleanup") : new Date(image.expires_at).toLocaleString(language)}</span></td>
                  <td className="px-3 py-3"><div className="flex gap-1">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPreview(image)}>{t("预览", "Preview")}</Button>
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => setDeleting(image)} aria-label={t(`删除 ${image.id}`, `Delete ${image.id}`)}>{t("删除", "Delete")}</Button>
                  </div></td>
                </tr>)}</tbody>
              </table>
            </div>
            {inventory.total_count > 20 && <div className="flex items-center justify-end gap-3 text-xs text-muted">
              <span>{offset + 1}–{Math.min(offset + 20, inventory.total_count)} / {inventory.total_count}</span>
              <Button size="sm" variant="ghost" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>{t("上一页", "Previous")}</Button>
              <Button size="sm" variant="ghost" disabled={busy || offset + 20 >= inventory.total_count} onClick={() => setOffset(offset + 20)}>{t("下一页", "Next")}</Button>
            </div>}
          </>}
        </>}
        {preview && <figure className="space-y-3 rounded-lg border border-line p-3">
          <figcaption className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="break-all font-mono">{preview.id}</span>
            <span className="flex items-center gap-3">
              {previewUrl && <a className="text-brand underline" href={previewUrl} download={`clipboard-${preview.id}`}>{t("下载图片", "Download image")}</a>}
              <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>{t("关闭预览", "Close preview")}</Button>
            </span>
          </figcaption>
          {previewUrl ? <img src={previewUrl} alt={t("缓存图片预览", "Cached image preview")} className="mx-auto max-h-96 max-w-full object-contain" /> : <p className="text-xs text-muted">{t("加载图片中...", "Loading image...")}</p>}
        </figure>}
      </div>
      <ConfirmDialog
        open={deleting !== null} title={t("删除缓存图片", "Delete cached image")}
        message={t("删除后无法再从此路径读取图片。需要保留的图片请先下载。", "This file path will stop working after deletion. Download the image first if you want to keep it.")}
        confirmText={t("删除图片", "Delete image")} cancelText={t("取消", "Cancel")} variant="danger" loading={busy}
        onConfirm={() => void deleteImage()} onCancel={() => setDeleting(null)}
      />
    </Card>
  );
}
