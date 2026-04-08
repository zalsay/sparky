package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"html/template"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Config struct {
	Port           int
	Model          string
	BaseURL        string
	AuthToken      string
	SessionTimeout time.Duration
	Bind           string
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

var cfg = Config{
	Port:           3001,
	Model:          getEnv("CLAUDE_MODEL", "codex"),
	BaseURL:        getEnv("ANTHROPIC_BASE_URL", "http://i.meetlife.com.cn:8318"),
	AuthToken:      getEnv("ANTHROPIC_AUTH_TOKEN", ""),
	SessionTimeout: 30 * time.Minute,
	Bind:           "0.0.0.0",
}

// ── Anthropic / OpenAI-compatible API call ────────────────────────────────────

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type APIRequest struct {
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`
	MaxTokens int       `json:"max_tokens"`
}

type APIResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func callAPI(model, prompt string, timeout time.Duration) (string, error) {
	reqBody := map[string]interface{}{
		"model": model,
		"messages": []Message{{Role: "user", Content: prompt}},
		"max_tokens": 4096,
		"stream": true,
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", cfg.BaseURL+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.AuthToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("API error %d: %s", resp.StatusCode, string(respBody))
	}

	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(contentType, "text/event-stream") {
		return readSSEContent(resp.Body)
	}

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return parseChatCompletionJSON(respBody)
}

func parseChatCompletionJSON(respBody []byte) (string, error) {
	var apiResp APIResponse
	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return "", err
	}

	if apiResp.Error != nil {
		return "", fmt.Errorf("API error: %s", apiResp.Error.Message)
	}

	if len(apiResp.Choices) == 0 {
		return "", fmt.Errorf("no response from API")
	}

	return strings.TrimSpace(apiResp.Choices[0].Message.Content), nil
}

func readSSEContent(r io.Reader) (string, error) {
	type sseChunk struct {
		Choices []struct {
			Delta struct {
				Content string `json:"content"`
			} `json:"delta"`
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}

	scanner := bufio.NewScanner(r)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)
	var out strings.Builder

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		if payload == "[DONE]" {
			break
		}

		var chunk sseChunk
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			return "", fmt.Errorf("decode SSE chunk: %w; payload=%s", err, payload)
		}
		if chunk.Error != nil {
			return "", fmt.Errorf("API error: %s", chunk.Error.Message)
		}
		for _, choice := range chunk.Choices {
			if choice.Delta.Content != "" {
				out.WriteString(choice.Delta.Content)
			} else if choice.Message.Content != "" {
				out.WriteString(choice.Message.Content)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	result := strings.TrimSpace(out.String())
	if result == "" {
		return "", fmt.Errorf("empty SSE response")
	}
	return result, nil
}

// ── Session Manager ──────────────────────────────────────────────────────────

type Session struct {
	ID      string
	History []Message
	mu      sync.Mutex
}

type SessionManager struct {
	mu sync.Mutex
	m  map[string]*Session
}

var sm = &SessionManager{m: make(map[string]*Session)}

func (sm *SessionManager) Create() *Session {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	id := randomID(8)
	s := &Session{ID: id, History: []Message{}}
	sm.m[id] = s
	return s
}

func (sm *SessionManager) Get(id string) *Session {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	return sm.m[id]
}

func (sm *SessionManager) Remove(id string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	delete(sm.m, id)
}

func (sm *SessionManager) Count() int {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	return len(sm.m)
}

// ── HTTP Handlers ─────────────────────────────────────────────────────────────

func health(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":   "ok",
		"sessions": sm.Count(),
	})
}

type ChatReq  struct{ Message string `json:"message"` }
type ChatResp struct{ Reply string `json:"reply"` }

func chat(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}
	var req ChatReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", 400)
		return
	}
	req.Message = strings.TrimSpace(req.Message)
	if req.Message == "" {
		http.Error(w, "empty message", 400)
		return
	}

	reply, err := callAPI(cfg.Model, req.Message, cfg.SessionTimeout)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ChatResp{Reply: reply})
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

func wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WS upgrade error: %v", err)
		return
	}
	defer conn.Close()

	session := sm.Create()
	sid := session.ID
	log.Printf("WS [%s] connected", sid)

	var conversation []string

	done := make(chan struct{})
	go func() {
		for {
			_, msgBytes, err := conn.ReadMessage()
			if err != nil {
				close(done)
				return
			}
			var payload map[string]string
			if err := json.Unmarshal(msgBytes, &payload); err != nil {
				continue
			}
			content, ok := payload["content"]
			if !ok || strings.TrimSpace(content) == "" {
				continue
			}

			conversation = append(conversation, content)
			prompt := strings.Join(conversation, "\n\n")

			conn.WriteJSON(map[string]string{"type": "thinking"})
			reply, err := callAPI(cfg.Model, prompt, cfg.SessionTimeout)
			if err != nil {
				conn.WriteJSON(map[string]string{"type": "error", "content": err.Error()})
				continue
			}
			conversation = append(conversation, reply)
			conn.WriteJSON(map[string]string{"type": "reply", "content": reply})
			conn.WriteJSON(map[string]string{"type": "done"})
		}
	}()

	<-done
	sm.Remove(sid)
	log.Printf("WS [%s] disconnected", sid)
}

// ── HTML ──────────────────────────────────────────────────────────────────────

var indexTpl = template.Must(template.New("index").Parse(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><title>CC-Bridge</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;-webkit-tap-highlight-color:transparent}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0a;color:#e0e0e0;height:100vh;height:100dvh;display:flex;flex-direction:column;overscroll-behavior:contain}
#h{padding:12px 16px;padding:12px 16px;padding-left:max(12px,env(safe-area-inset-left));padding-right:max(12px,env(safe-area-inset-right));background:#1a1a2e;border-bottom:1px solid #333;font-size:15px;font-weight:600;color:#7ec8e3;display:flex;justify-content:space-between;align-items:center;flex-shrink:0}
#s{font-size:11px;font-weight:400;color:#888}
#c{flex:1;overflow-y:auto;overflow-x:hidden;padding:16px;display:flex;flex-direction:column;gap:10px;-webkit-overflow-scrolling:touch}
.msg{max-width:85%;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;word-break:break-all}
.msg.user{align-self:flex-end;background:#2563eb;color:#fff;border-bottom-right-radius:4px}
.msg.assistant{align-self:flex-start;background:#1e1e2e;border:1px solid #333;border-bottom-left-radius:4px}
.msg.system{align-self:center;background:#1a1a1a;color:#666;font-size:12px;border-radius:8px;text-align:center}
.msg.thinking{align-self:flex-start;background:transparent;color:#555;font-size:13px;font-style:italic}
#a{padding:12px;padding:left:max(12px,env(safe-area-inset-left));padding-right:max(12px,env(safe-area-inset-right));padding-bottom:max(12px,env(safe-area-inset-bottom));background:#1a1a2e;border-top:1px solid #333;display:flex;gap:10px;align-items:flex-end;flex-shrink:0}
#i{flex:1;background:#0a0a0a;border:1px solid #333;color:#e0e0e0;padding:12px 14px;border-radius:10px;font-size:16px;outline:none;min-height:44px;max-height:120px;resize:none;overflow-y:auto;-webkit-appearance:none}
#i:focus{border-color:#2563eb}
#b{background:#2563eb;color:#fff;border:none;padding:12px 20px;border-radius:10px;font-size:15px;cursor:pointer;flex-shrink:0;min-height:44px;min-width:44px;font-weight:500;-webkit-tap-highlight-color:transparent}
#b:hover{background:#1d4ed8}
#b:active{background:#1e40af}
#b:disabled{opacity:0.5;cursor:not-allowed}
@media(max-width:480px){
.msg{max-width:90%}
}</style></head>
<body>
<div id="h">CC-Bridge <span id="s">● Initializing...</span></div>
<div id="c"><div class="msg system">Connecting to Claude Code...</div></div>
<div id="a">
  <input id="i" placeholder="Ask Claude Code..." autocomplete="off" disabled/>
  <button id="b" disabled>Send</button>
</div>
<script>
const c=document.getElementById('c'),i=document.getElementById('i'),b=document.getElementById('b'),s=document.getElementById('s');
let ws,connected,lastAssistant;
function log(t,r){const d=document.createElement('div');d.className='msg '+r;d.textContent=t;c.appendChild(d);c.scrollTop=c.scrollHeight;if(r==='assistant')lastAssistant=d}
function append(t){if(!lastAssistant||lastAssistant.className!=='msg assistant'){log(t,'assistant');return};lastAssistant.textContent+=t;c.scrollTop=c.scrollHeight}
function setThinking(on){if(on){lastAssistant=null;log('thinking...','thinking')}else{lastAssistant=null}}
function send(){const t=i.value.trim();if(!t||!connected)return;log(t,'user');i.value='';b.disabled=true;i.disabled=true;ws.send(JSON.stringify({type:'message',content:t}))}
ws=new WebSocket('ws://'+location.host+'/ws');
ws.onopen=()=>{connected=true;s.textContent='● Connected';s.style.color='#4ade80';log('Ready. Ask me anything.','system');i.disabled=false;b.disabled=false};
ws.onclose=()=>{connected=false;s.textContent='● Disconnected';s.style.color='#ef4444';b.disabled=true;i.disabled=true};
ws.onerror=()=>{s.textContent='● Error';s.style.color='#ef4444'};
ws.onmessage=e=>{try{const d=JSON.parse(e.data);if(d.type==='reply')append(d.content);else if(d.type==='done'){b.disabled=false;i.disabled=false;lastAssistant=null}else if(d.type==='thinking')setThinking(true);else if(d.type==='error'){setThinking(false);log('error: '+d.content,'system');b.disabled=false;i.disabled=false}}catch{}};
i.addEventListener('keydown',e=>{if(e.key==='Enter')send()});
b.onclick=send;
</script>
</body></html>`))

func serveIndex(w http.ResponseWriter, r *http.Request) {
	// Serve static files from ./dist (React build output)
	distDir := os.Getenv("DIST_DIR")
	if distDir == "" {
		distDir = "./dist"
	}
	filePath := filepath.Join(distDir, "index.html")
	http.ServeFile(w, r, filePath)
}

// serveAssets serves static assets from the dist directory
func serveAssets(w http.ResponseWriter, r *http.Request) {
	distDir := os.Getenv("DIST_DIR")
	if distDir == "" {
		distDir = "./dist"
	}
	// Strip the /assets/ prefix and map to dist/assets/
	filePath := filepath.Join(distDir, r.URL.Path)
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, filePath)
}

// ── Utils ─────────────────────────────────────────────────────────────────────

func randomID(n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	r := time.Now().UnixNano()
	for i := range b {
		b[i] = letters[r%int64(len(letters))]
		r = r/int64(len(letters)) + int64(i)
	}
	return string(b)
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	flag.IntVar(&cfg.Port, "port", cfg.Port, "HTTP port")
	flag.StringVar(&cfg.Model, "model", cfg.Model, "Claude model")
	flag.StringVar(&cfg.BaseURL, "base-url", cfg.BaseURL, "Anthropic API base URL")
	flag.StringVar(&cfg.AuthToken, "auth-token", cfg.AuthToken, "Auth token")
	flag.DurationVar(&cfg.SessionTimeout, "timeout", cfg.SessionTimeout, "Session timeout")
	flag.StringVar(&cfg.Bind, "bind", cfg.Bind, "Bind address")
	flag.Parse()

	// Env overrides
	if p := os.Getenv("PORT"); p != "" {
		fmt.Sscanf(p, "%d", &cfg.Port)
	}
	if m := os.Getenv("CLAUDE_MODEL"); m != "" {
		cfg.Model = m
	}
	if b := os.Getenv("ANTHROPIC_BASE_URL"); b != "" {
		cfg.BaseURL = b
	}
	if a := os.Getenv("ANTHROPIC_AUTH_TOKEN"); a != "" {
		cfg.AuthToken = a
	}

	http.HandleFunc("/health", health)
	http.HandleFunc("/api/chat", chat)
	http.HandleFunc("/ws", wsHandler)
	http.HandleFunc("/assets/", serveAssets)
	http.HandleFunc("/", serveIndex)

	addr := fmt.Sprintf("%s:%d", cfg.Bind, cfg.Port)
	log.Printf("CC-Bridge starting on %s (model=%s, base=%s)", addr, cfg.Model, cfg.BaseURL)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatal(err)
	}
}
