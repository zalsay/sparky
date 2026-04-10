export function SidePanelTabs({ isCodexProject, onSelectTab, sidePanelTab }) {
  return (
    <div className="side-panel-tabs" role="tablist" aria-label="右侧面板">
      {isCodexProject ? (
        <button
          type="button"
          role="tab"
          aria-selected={sidePanelTab === 'codex'}
          className={`side-panel-tab ${sidePanelTab === 'codex' ? 'active' : ''}`}
          onClick={() => onSelectTab('codex')}
        >
          Codex
        </button>
      ) : null}
      <button
        type="button"
        role="tab"
        aria-selected={sidePanelTab === 'web'}
        className={`side-panel-tab ${sidePanelTab === 'web' ? 'active' : ''}`}
        onClick={() => onSelectTab('web')}
      >
        Web 开发
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={sidePanelTab === 'files'}
        className={`side-panel-tab ${sidePanelTab === 'files' ? 'active' : ''}`}
        onClick={() => onSelectTab('files')}
      >
        文件
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={sidePanelTab === 'git'}
        className={`side-panel-tab ${sidePanelTab === 'git' ? 'active' : ''}`}
        onClick={() => onSelectTab('git')}
      >
        Git
      </button>
    </div>
  )
}
