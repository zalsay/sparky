"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = require("vscode");
const http = require("http");
let statusBarItem;
function sendCodeToTerminal(code) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ code });
        const req = http.request({
            hostname: '127.0.0.1',
            port: 18081,
            path: '/send-to-terminal',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve();
                }
                else {
                    reject(new Error(body || `HTTP ${res.statusCode}`));
                }
            });
        });
        req.on('error', (e) => reject(e));
        req.setTimeout(3000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.write(postData);
        req.end();
    });
}
function activate(context) {
    console.log('claude-monitor-ext is now active!');
    // 1. Create a status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'claudeMonitor.sendSelectionToTerminal';
    statusBarItem.text = '$(terminal) 发送到 Sparky 终端';
    statusBarItem.tooltip = '将选中代码发送到当前的 Sparky 终端';
    context.subscriptions.push(statusBarItem);
    // 2. Register the command that sends the selected code via HTTP
    const sendCommand = vscode.commands.registerCommand('claudeMonitor.sendSelectionToTerminal', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const selection = editor.selection;
        const text = editor.document.getText(selection);
        if (text) {
            try {
                await sendCodeToTerminal(text);
                vscode.window.showInformationMessage('代码已发送到 Sparky 终端');
            }
            catch (e) {
                vscode.window.showErrorMessage(`发送失败: ${e.message}`);
            }
        }
    });
    context.subscriptions.push(sendCommand);
    // 3. Add a hover provider so a clickable link appears when hovering over selected text
    const hoverProvider = vscode.languages.registerHoverProvider('*', {
        provideHover(document, position, token) {
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.selection.isEmpty && editor.selection.contains(position)) {
                // Return a hover with a command link
                const commandUri = vscode.Uri.parse('command:claudeMonitor.sendSelectionToTerminal');
                const contents = new vscode.MarkdownString(`[$(telescope) 发送到 Sparky 终端](${commandUri} "将选中的代码发送到活动终端")`);
                contents.isTrusted = true;
                contents.supportThemeIcons = true;
                return new vscode.Hover(contents);
            }
        }
    });
    context.subscriptions.push(hoverProvider);
    // 4. Listen for selection changes to show/hide the status bar item
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