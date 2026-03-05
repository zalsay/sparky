const text1 = "File not found: /opt/homebrew/Cellar/code-server/4.109.5/libexec/lib/vscode/node_modules/vsda/rust/web/vsda_bg.wasm";
const text2 = "  ➜  Local:   http://localhost:51760/";
const text3 = "[127.0.0.1][e5e44651][ExtensionHostConnection] <73534> Launched Extension Host Process.";

const pathRegex = /(?:^|\s)(\/?|\.\/|\.\.\/|~\/)([a-zA-Z0-9_.\-]+(?:\/[a-zA-Z0-9_.\-]+)+)(?::\d+)?/g;

function testMatch(text) {
    let match;
    console.log("Testing:", text);
    while ((match = pathRegex.exec(text)) !== null) {
        console.log("MATCH:", match[0]);
    }
}
testMatch(text1);
testMatch(text2);
testMatch(text3);
