"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = require("vscode");
let statusBarItem;
function activate(context) {
    console.log('claude-monitor-ext is now active!');
    // 1. Create a status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'claudeMonitor.sendSelectionToTerminal';
    statusBarItem.text = '$(terminal) 发送到 Sparky 终端';
    statusBarItem.tooltip = '将选中代码发送到当前的 Sparky 终端';
    context.subscriptions.push(statusBarItem);
    // 2. Register the command that actually sends the data
    const sendCommand = vscode.commands.registerCommand('claudeMonitor.sendSelectionToTerminal', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const selection = editor.selection;
        const text = editor.document.getText(selection);
        if (text) {
            // We need to send this text to the outer React app.
            // Since this extension runs inside code-server (which is embedded in an iframe in our React app),
            // and we might be constrained by the VS Code extension host (which runs in a Web Worker in the browser),
            // we create an invisible Webview. The Webview has access to the DOM window and can use postMessage
            // to message window.parent (the React App).
            const panel = vscode.window.createWebviewPanel('claudeMonitorPostMessage', 'Invisible Communicator', vscode.ViewColumn.Active, { enableScripts: true });
            // Hide it immediately or don't even show it (it's tricky to make it fully invisible, but we close it fast)
            // But wait, creating a panel might be intrusive to the user's layout.
            // An alternative is an invisible WebviewView if we had a view contributed, but a simpler hack:
            // Just use a panel and dispose it immediately after it loads and posts the message.
            panel.webview.html = `
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Sender</title>
                </head>
                <body>
                    <script>
                        // Try to post message to the parent of the code-server iframe
                        try {
                            // We might be 2 or 3 iframes deep (Webview iframe -> Code-Server iframe -> React App)
                            // So we just post to the topmost window or parent window
                            const message = { 
                                type: 'SEND_TO_TERMINAL', 
                                code: ${JSON.stringify(text)} 
                            };
                            if (window.top !== window) {
                                window.top.postMessage(message, '*');
                            }
                            if (window.parent !== window) {
                                window.parent.postMessage(message, '*');
                            }
                            // Notify extension that we are done
                            const vscode = acquireVsCodeApi();
                            vscode.postMessage({ command: 'done' });
                        } catch (e) {}
                    </script>
                </body>
                </html>
            `;
            panel.webview.onDidReceiveMessage(message => {
                if (message.command === 'done') {
                    panel.dispose();
                    vscode.window.showInformationMessage('代码已发送到 Sparky 终端');
                }
            }, undefined, context.subscriptions);
            // Fallback: dispose after 1 second just in case
            setTimeout(() => {
                try {
                    panel.dispose();
                }
                catch (e) { }
            }, 1000);
        }
    });
    context.subscriptions.push(sendCommand);
    // 2.5 Add a hover provider so a clickable link appears when hovering over selected text
    const hoverProvider = vscode.languages.registerHoverProvider('*', {
        provideHover(document, position, token) {
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.selection.isEmpty && editor.selection.contains(position)) {
                // Return a hover with a command link
                const commandUri = vscode.Uri.parse('command:claudeMonitor.sendSelectionToTerminal');
                const contents = new vscode.MarkdownString(`[$(telescope) 发送到 Sparky 终端](${commandUri} "将选中的代码发送到活动终端")`);
                contents.isTrusted = true; // Required to allow executing commands from the hover
                contents.supportThemeIcons = true; // Required to render $(icon) syntax
                return new vscode.Hover(contents);
            }
        }
    });
    context.subscriptions.push(hoverProvider);
    // 3. Listen for selection changes to show/hide the status bar item
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(updateStatusBarItem));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatusBarItem));
    // Initial check
    updateStatusBarItem();
}
exports.activate = activate;
function updateStatusBarItem() {
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.selection.isEmpty) {
        statusBarItem.show();
    }
    else {
        statusBarItem.hide();
    }
}
function deactivate() { }
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map