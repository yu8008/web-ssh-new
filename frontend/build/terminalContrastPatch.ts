import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import type { Plugin } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const core = path.join(root, "node_modules/@xterm/xterm");
const addon = path.join(root, "node_modules/@xterm/addon-webgl");
const policy = path.join(root, "src/pages/terminal/terminalContrast.ts");
const virtualId = "\0webssh-terminal-renderers";
const policyImport = `import { usesTerminalTextPolicy, readableTerminalForeground } from ${JSON.stringify(policy)};\n`;

/** Patches are applied to the pinned packages' source in memory. Neither
 * node_modules nor generated vendor bundles need to be edited or committed. */
const patches = new Map<string, Array<[string, string]>>([
  [path.join(core, "src/browser/renderer/dom/DomRendererRowFactory.ts"), [
    ["this._applyMinimumContrast(charElement, resolvedBg, colors.foreground, cell, bgOverride, fgOverride)",
      "this._applyMinimumContrast(charElement, resolvedBg, isInverse && usesTerminalTextPolicy(colors.background.rgba, this._optionsService.rawOptions.minimumContrastRatio) ? colors.background : colors.foreground, cell, bgOverride, fgOverride)"],
    ["if (!bgOverride) {\n        if (cell.isDim()) {",
      "if (!bgOverride && !usesTerminalTextPolicy(colors.background.rgba, this._optionsService.rawOptions.minimumContrastRatio)) {\n        if (cell.isDim()) {"],
    ["    // Try get from cache first, only use the cache when there are no decoration overrides",
      `    if (usesTerminalTextPolicy(this._themeService.colors.background.rgba, this._optionsService.rawOptions.minimumContrastRatio)) {
      const background = bgOverride ? color.blend(bg, bgOverride) : bg;
      const foreground = fgOverride ? color.blend(background, fgOverride) : fg;
      const cache = this._getContrastCache(cell);
      let resolved = cache.getColor(background.rgba, foreground.rgba);
      if (!resolved) {
        resolved = readableTerminalForeground(background.rgba, foreground.rgba, !!cell.isDim(), this._themeService.colors.selectionBackgroundOpaque.rgba, this._optionsService.rawOptions.minimumContrastRatio === 7);
        cache.setColor(background.rgba, foreground.rgba, resolved);
      }
      this._addStyle(element, \`color:\${resolved.css}\`);
      return true;
    }

    // Try get from cache first, only use the cache when there are no decoration overrides`],
  ]],
  [path.join(addon, "src/TextureAtlas.ts"), [
    ["    // Dim cells only require half the contrast, otherwise they wouldn't be distinguishable from",
      `    if (usesTerminalTextPolicy(this._config.colors.background.rgba, this._config.minimumContrastRatio)) {
      const resolved = readableTerminalForeground(bgRgba, fgRgba, dim, this._config.colors.selectionBackgroundOpaque.rgba, this._config.minimumContrastRatio === 7);
      cache.setColor(bg, fg, resolved);
      return resolved;
    }
    // Dim cells only require half the contrast, otherwise they wouldn't be distinguishable from`],
  ]],
  [path.join(addon, "src/CharAtlasUtils.ts"), [
    // Disposed atlases can still finish idle glyph warmup. A cache shared with
    // ThemeService lets that old palette overwrite the new theme's colors.
    ["import { NULL_COLOR } from 'common/Color';", "import { NULL_COLOR } from 'common/Color';\nimport { ColorContrastCache } from 'browser/ColorContrastCache';"],
    ["contrastCache: colors.contrastCache", "contrastCache: new ColorContrastCache()"],
    ["halfContrastCache: colors.halfContrastCache", "halfContrastCache: new ColorContrastCache()"],
    ["selectionBackgroundOpaque: NULL_COLOR", "selectionBackgroundOpaque: colors.selectionBackgroundOpaque"],
    ["a.minimumContrastRatio === b.minimumContrastRatio &&",
      "a.minimumContrastRatio === b.minimumContrastRatio &&\n      a.colors.selectionBackgroundOpaque.rgba === b.colors.selectionBackgroundOpaque.rgba &&"],
  ]],
  [path.join(core, "src/browser/services/ThemeService.ts"), [
    ["() => this._contrastCache.clear()",
      "() => { this._contrastCache.clear(); this._halfContrastCache.clear(); }"],
  ]],
]);

async function bundleRenderers(): Promise<string> {
  for (const [directory, version] of [[core, "6.0.0"], [addon, "0.19.0"]]) {
    const installed = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    if (installed.version !== version) throw new Error(`Terminal contrast patch requires ${installed.name}@${version}; found ${installed.version}`);
  }
  const applied = new Set<string>();
  const result = await build({
    stdin: {
      contents: `export { Terminal } from ${JSON.stringify(path.join(core, "src/browser/public/Terminal.ts"))};\n`
        + `export { WebglAddon } from ${JSON.stringify(path.join(addon, "src/WebglAddon.ts"))};`,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    write: false,
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    plugins: [{
      name: "terminal-contrast-source-patch",
      setup(builder) {
        builder.onResolve({ filter: /^(browser|common|vs)\// }, args => ({ path: path.join(core, "src", args.path + ".ts") }));
        builder.onLoad({ filter: /(?:DomRendererRowFactory|TextureAtlas|ThemeService|CharAtlasUtils)\.ts$/ }, async args => {
          const replacements = patches.get(args.path);
          if (!replacements) return;
          let source = await readFile(args.path, "utf8");
          for (const [before, after] of replacements) {
            if (source.split(before).length !== 2) throw new Error(`Terminal contrast patch no longer matches ${args.path}`);
            source = source.replace(before, after);
          }
          applied.add(args.path);
          return { contents: policyImport + source, loader: "ts", resolveDir: path.dirname(args.path) };
        });
      },
    }],
  });
  if (applied.size !== patches.size) throw new Error("Terminal contrast patch did not reach every renderer source");
  return result.outputFiles[0].text;
}

export function terminalContrastPatch(): Plugin {
  let bundled: Promise<string> | undefined;
  return {
    name: "webssh-terminal-contrast",
    enforce: "pre",
    resolveId(id) {
      if (id === "@xterm/xterm" || id === "@xterm/addon-webgl") return virtualId;
    },
    load(id) {
      if (id === virtualId) return bundled ??= bundleRenderers();
    },
    configureServer(server) { server.watcher.add(policy); },
    handleHotUpdate(context) {
      if (context.file !== policy) return;
      bundled = undefined;
      const module = context.server.moduleGraph.getModuleById(virtualId);
      if (module) {
        context.server.moduleGraph.invalidateModule(module);
        return [module];
      }
    },
  };
}
