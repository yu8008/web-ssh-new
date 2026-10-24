import { ArrowDown, ArrowUp, Check, ChevronDown, CircleAlert, FileCode2, GitBranch, Link2, Loader2, RefreshCw } from "lucide-react";
import type { SessionProjectState } from "./useSessionProject";

type Props = { project: SessionProjectState; t: (zh: string, en: string) => string };
export function TerminalGitPanel({ project, t }: Props) {
  const { data, loading, error, connected, refresh } = project;
  const git = data?.git;
  const ready = data?.state === "ready" && git?.state === "ready";
  const branch = git?.detached ? `${t("分离 HEAD", "Detached HEAD")} · ${git.oid?.slice(0, 7)}` : git?.branch;
  const count = (git?.changed_files ?? 0) + (git?.untracked_files ?? 0);
  let message = t("正在读取项目状态…", "Reading project status…");
  if (!connected) message = t("终端已断开，连接后继续同步。", "Terminal disconnected. Reconnect to resume.");
  else if (error || data?.state === "unavailable") message = t("暂时无法获取终端项目目录。", "The terminal project directory is unavailable.");
  else if (git?.state === "not_repository") message = t("待连接 · 当前目录没有可读取的 Git 仓库。", "Not connected · No readable Git repository in this directory.");
  else if (git?.state === "unavailable") message = git.reason === "git_missing"
    ? t("服务器尚未安装 Git。", "Git is not installed on the server.")
    : git.reason === "too_large" || git.reason === "timeout"
    ? t("仓库较大，暂未完成统计。请稍后刷新。", "Repository scan exceeded its limit. Refresh to try again.")
    : t("Git 状态暂时不可用，请稍后刷新。", "Git status is unavailable. Refresh to try again.");
  return <section className="git-panel flex h-full min-h-0 flex-col" aria-label={t("Git 项目状态", "Git project status")}>
    <header className="flex shrink-0 items-center gap-2 border-b border-line pb-3 pr-7">
      <GitBranch size={16} className="text-brand" /><h3 className="text-base font-semibold">{t("Git 管理", "Git")}</h3>
      <button type="button" onClick={refresh} disabled={loading || !connected} className="ml-auto rounded p-1.5 text-muted hover:bg-elevated hover:text-brand disabled:opacity-50" aria-label={t("刷新 Git 状态", "Refresh Git status")}>
        <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
      </button>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto py-3">
      {data?.cwd && <p className="mb-4 break-all font-mono text-sm leading-relaxed text-muted" title={data.cwd}>{data.cwd}</p>}
      {!ready ? <div className="flex items-start gap-2 py-6 text-sm leading-relaxed text-muted" role="status">
        {loading && !data ? <Loader2 size={16} className="shrink-0 animate-spin" /> : <CircleAlert size={16} className="shrink-0" />}{message}
      </div> : <>
        <div className="mb-4 flex items-center gap-2 text-sm">
          <Link2 size={14} className={git.remotes?.length ? "text-brand" : "text-warn"} />
          <span className={git.remotes?.length ? "text-ink-soft" : "text-warn"}>{git.remotes?.length ? `${t("已配置远端", "Remote configured")} · ${git.remotes.join(", ")}` : t("待连接远端", "Remote not configured")}</span>
        </div>
        <details className="git-branches rounded-xl border border-line bg-elevated/30">
          <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-sm"><GitBranch size={15} className="text-brand" /><span className="min-w-0 flex-1 break-all">{branch}</span><ChevronDown size={14} className="text-muted" /></summary>
          <div className="max-h-40 overflow-y-auto border-t border-line px-3 py-2">
            {(git.branches ?? []).map(name => <div key={name} className="flex items-center gap-2 py-1.5 font-mono text-sm"><span className="min-w-0 flex-1 break-all">{name}</span>{name === git.branch && <Check size={13} className="text-brand" />}</div>)}
            {git.unborn && <p className="py-2 text-sm text-muted">{t("尚无提交", "No commits yet")}</p>}
            {git.branches_truncated && <p className="py-2 text-sm text-muted">{t("仅显示前 100 个分支", "Showing the first 100 branches")}</p>}
          </div>
        </details>
        {git.upstream && <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted"><span className="break-all">{git.upstream}</span><span className="inline-flex items-center gap-1"><ArrowUp size={12} />{git.ahead}</span><span className="inline-flex items-center gap-1"><ArrowDown size={12} />{git.behind}</span></div>}
        <div className="git-change-summary my-4 grid grid-cols-3 gap-2 rounded-xl border border-line p-3">
          <div><strong className="block text-xl font-medium">{count}</strong><span className="text-xs text-muted">{t("变更文件", "Changed files")}</span></div>
          <div><strong className="block text-xl font-medium text-ok">+{git.added_lines}</strong><span className="text-xs text-muted">{t("新增行", "Added lines")}</span></div>
          <div><strong className="block text-xl font-medium text-danger">−{git.deleted_lines}</strong><span className="text-xs text-muted">{t("删除行", "Deleted lines")}</span></div>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-muted">{git.unborn ? t("尚无提交，行数按已跟踪文件相对空仓库统计。", "No commits yet; tracked lines are compared with an empty repository.") : t("行数为已跟踪文件相对 HEAD 的净变化，包含暂存和未暂存修改。", "Line totals are tracked changes against HEAD, including staged and unstaged edits.")}</p>
        {(git.untracked_files ?? 0) > 0 && <p className="mb-2 text-sm text-muted">{t(`另有 ${git.untracked_files} 个未跟踪文件，尚未计入行数。`, `${git.untracked_files} untracked files; their lines are not included.`)}</p>}
        {(git.binary_files ?? 0) > 0 && <p className="mb-2 text-sm text-muted">{t(`${git.binary_files} 个二进制文件，不统计行数。`, `${git.binary_files} binary files; no line counts.`)}</p>}
        {(git.conflicted_files ?? 0) > 0 && <p className="mb-2 text-sm text-warn">{t(`${git.conflicted_files} 个文件存在冲突`, `${git.conflicted_files} conflicted files`)}</p>}
        {count === 0 ? <p className="flex items-center gap-2 py-4 text-sm text-muted"><Check size={14} className="text-ok" />{t("工作区干净", "Working tree clean")}</p> : <ul className="divide-y divide-line">
          {git.files?.map(file => <li key={file.path} className="flex items-start gap-2 py-2.5 text-sm"><FileCode2 size={14} className="mt-0.5 shrink-0 text-muted" /><span className="min-w-0 flex-1 break-all font-mono">{file.path}</span><span className="shrink-0 font-mono text-brand">{file.status}</span></li>)}
        </ul>}
        {git.files_truncated && <p className="py-2 text-sm text-muted">{t("列表仅显示前 100 个文件，统计包含全部变更。", "Showing the first 100 files; totals include all changes.")}</p>}
      </>}
    </div>
    <p className="shrink-0 border-t border-line pt-2 text-xs text-muted">{t("跟随终端项目 · 自动刷新", "Follows terminal project · Auto refresh")}{git?.upstream && <span className="mt-1 block">{t("领先／落后基于本地远端引用。", "Ahead/behind uses locally stored remote refs.")}</span>}</p>
  </section>;
}
