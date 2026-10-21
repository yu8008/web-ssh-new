import { describe, expect, it } from "vitest";
import {
  buildDefaultColorAnnouncement,
  clampSelectionAnchor,
  createTerminalBufferSnapshot,
  resolveCopyText,
  toX11RgbColor,
} from "./terminalUtils";

type FakeLine = {
  isWrapped: boolean;
  translateToString: (trimRight?: boolean) => string;
};

function line(text: string, isWrapped = false): FakeLine {
  return {
    isWrapped,
    translateToString: () => text,
  };
}

function buffer(
  lines: Array<FakeLine | undefined>,
  position: { baseY?: number; viewportY?: number } = {}
) {
  return {
    length: lines.length,
    baseY: position.baseY ?? 0,
    viewportY: position.viewportY ?? 0,
    getLine: (index: number) => lines[index],
  };
}

describe("createTerminalBufferSnapshot", () => {
  it("合并 wrapped 行并保留中文", () => {
    const result = createTerminalBufferSnapshot(
      buffer([
        line("deploy "),
        line("成功", true),
        line("next"),
      ])
    );

    expect(result).toEqual({
      text: "deploy 成功\nnext",
      loadedLines: 3,
      truncated: false,
      initialScrollRatio: 0,
    });
  });

  it("移除末尾空行但保留已读取行数", () => {
    const result = createTerminalBufferSnapshot(
      buffer([
        line("command output"),
        line(""),
        line(""),
      ])
    );

    expect(result).toEqual({
      text: "command output",
      loadedLines: 3,
      truncated: false,
      initialScrollRatio: 0,
    });
  });

  it("只保留行数预算内的最新输出", () => {
    const result = createTerminalBufferSnapshot(
      buffer([
        line("old"),
        line("middle"),
        line("中文-newest"),
      ]),
      { maxLines: 1, maxChars: 1024 }
    );

    expect(result).toEqual({
      text: "中文-newest",
      loadedLines: 1,
      truncated: true,
      initialScrollRatio: 0,
    });
  });

  it("从 wrapped 逻辑行中段开始时回溯到逻辑行起点", () => {
    const result = createTerminalBufferSnapshot(
      buffer([
        line("prefix "),
        line("continued ", true),
        line("tail", true),
        line("newest"),
      ]),
      { maxLines: 3, maxChars: 1024 }
    );

    expect(result).toEqual({
      text: "prefix continued tail\nnewest",
      loadedLines: 4,
      truncated: false,
      initialScrollRatio: 0,
    });
  });

  it("字符预算优先保留最新输出", () => {
    const result = createTerminalBufferSnapshot(
      buffer([
        line("old-output"),
        line("new"),
      ]),
      { maxLines: 10, maxChars: 4 }
    );

    expect(result).toEqual({
      text: "new",
      loadedLines: 1,
      truncated: true,
      initialScrollRatio: 0,
    });
  });

  it("单个超长行截断时不拆分 UTF-16 代理对", () => {
    const result = createTerminalBufferSnapshot(
      buffer([line("A😀B")]),
      { maxLines: 10, maxChars: 2 }
    );

    expect(result).toEqual({
      text: "B",
      loadedLines: 1,
      truncated: true,
      initialScrollRatio: 0,
    });
  });

  it("跳过缺失的 buffer 行且不抛出异常", () => {
    const result = createTerminalBufferSnapshot(
      buffer([
        line("first"),
        undefined,
        line("last"),
      ])
    );

    expect(result).toEqual({
      text: "first\nlast",
      loadedLines: 2,
      truncated: false,
      initialScrollRatio: 0,
    });
  });

  it("空 buffer 返回空快照", () => {
    expect(createTerminalBufferSnapshot(buffer([]))).toEqual({
      text: "",
      loadedLines: 0,
      truncated: false,
      initialScrollRatio: 0,
    });
  });

  it("终端位于底部时将初始滚动比例映射到末尾", () => {
    const result = createTerminalBufferSnapshot(
      buffer(Array.from({ length: 10 }, (_, index) => line(String(index))), {
        baseY: 6,
        viewportY: 6,
      })
    );

    expect(result.initialScrollRatio).toBe(1);
  });

  it("终端位于历史中间时保留近似 viewport 比例", () => {
    const result = createTerminalBufferSnapshot(
      buffer(Array.from({ length: 10 }, (_, index) => line(String(index))), {
        baseY: 8,
        viewportY: 4,
      })
    );

    expect(result.initialScrollRatio).toBe(0.5);
  });

  it("viewport 位于已截断快照之前时定位到快照顶部", () => {
    const result = createTerminalBufferSnapshot(
      buffer(Array.from({ length: 10 }, (_, index) => line(String(index))), {
        baseY: 8,
        viewportY: 4,
      }),
      { maxLines: 4 }
    );

    expect(result.initialScrollRatio).toBe(0);
  });

  it("没有 scrollback 时使用顶部且不产生 NaN", () => {
    const result = createTerminalBufferSnapshot(
      buffer([line("screen")], { baseY: 0, viewportY: 0 })
    );

    expect(result.initialScrollRatio).toBe(0);
    expect(Number.isFinite(result.initialScrollRatio)).toBe(true);
  });
});

describe("toX11RgbColor", () => {
  it("把 #rrggbb 转成 X11 rgb 描述并重复通道", () => {
    expect(toX11RgbColor("#020617")).toBe("rgb:0202/0606/1717");
    expect(toX11RgbColor("#E2E8F0")).toBe("rgb:e2e2/e8e8/f0f0");
  });

  it("非法颜色返回 null", () => {
    expect(toX11RgbColor("red")).toBeNull();
    expect(toX11RgbColor("#12345")).toBeNull();
    expect(toX11RgbColor("")).toBeNull();
  });
});

describe("buildDefaultColorAnnouncement", () => {
  it("依次输出 OSC 10/11/12 应答并以 ST 结尾", () => {
    const payload = buildDefaultColorAnnouncement({
      foreground: "#e2e8f0",
      background: "#020617",
      cursor: "#e2e8f0",
    });
    const escape = "\u001b";
    expect(payload).toBe(
      escape + "]10;rgb:e2e2/e8e8/f0f0" + escape + "\\" +
        escape + "]11;rgb:0202/0606/1717" + escape + "\\" +
        escape + "]12;rgb:e2e2/e8e8/f0f0" + escape + "\\"
    );
  });

  it("没有合法颜色时返回空串", () => {
    expect(buildDefaultColorAnnouncement({ foreground: "", background: "", cursor: "" })).toBe("");
  });
});

describe("clampSelectionAnchor", () => {
  const bounds = { width: 800, height: 400 };

  it("把气泡放在指针右下方一点", () => {
    expect(clampSelectionAnchor(300, 200, bounds)).toEqual({ x: 300, y: 212 });
  });

  it("靠近边缘时夹紧到容器内", () => {
    expect(clampSelectionAnchor(795, 395, bounds)).toEqual({ x: 784, y: 384 });
    expect(clampSelectionAnchor(-20, -30, bounds)).toEqual({ x: 16, y: 16 });
  });

  it("容器很小时不会把坐标夹成负数", () => {
    expect(clampSelectionAnchor(5, 5, { width: 20, height: 20 }, { margin: 16 })).toEqual({
      x: 16,
      y: 16,
    });
  });

  it("支持自定义边距与偏移", () => {
    expect(clampSelectionAnchor(100, 100, bounds, { margin: 8, offsetY: 0 })).toEqual({
      x: 100,
      y: 100,
    });
  });
});

describe("resolveCopyText", () => {
  it("优先返回终端选区", () => {
    expect(resolveCopyText("terminal", "dom")).toBe("terminal");
  });

  it("终端没有选区时回退到 DOM 选区", () => {
    expect(resolveCopyText("", "dom")).toBe("dom");
  });

  it("两者都为空返回空串", () => {
    expect(resolveCopyText("", "")).toBe("");
  });
});
