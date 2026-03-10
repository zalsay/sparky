# Chrome 独立窗口对齐（macOS）计划

## 目标
- 仅在 macOS 上，通过 Rust/Tauri 启动系统 Chrome。
- Chrome 作为独立窗口运行，但位置与项目详情页左侧区域对齐。

## 现状梳理
- 前端：`ui/src/App.tsx` 已有 `chromeHostRef` 作为占位区域，并在进入项目详情时调用：
  - `launch_chrome_with_tabs` 打开 Chrome
  - `set_chrome_bounds` 根据 `chromeHostRef` 的 DOM 矩形设置 Chrome 窗口位置
- 后端：`src-tauri/src/chrome_embed.rs` 已实现 macOS 上的 `launch_chrome_with_tabs` 与 `set_chrome_bounds`（通过 `open` 与 `osascript`）。

## 计划步骤
1. **确认触发条件**
   - 仅在 `project-detail` 页面并且 `codeServerConnected !== false` 时启动与对齐。
2. **对齐逻辑检查**
   - 使用 `chromeHostRef.getBoundingClientRect()` 获取左侧区域坐标与尺寸。
   - 调用 `set_chrome_bounds` 更新窗口位置与大小。
3. **补充刷新机制**
   - 保持现有 `window.resize` 监听。
   - 在 `Splitter` 拖动时复用现有 `onResize`，同步调用一次 `set_chrome_bounds`。
4. **异常处理与提示**
   - macOS 以外直接提示不支持（已有后端处理）。
   - 启动/对齐失败打印控制台日志（保持现有模式）。

## 交付物
- 若需小改动：仅调整 `ui/src/App.tsx` 的事件触发与对齐更新逻辑。
- 如需后端增强：补充到 `src-tauri/src/chrome_embed.rs`。
