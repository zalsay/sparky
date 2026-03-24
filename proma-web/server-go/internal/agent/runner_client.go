package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type RunnerClient struct {
	baseURL    string
	httpClient *http.Client
}

func NewRunnerClient(baseURL string, timeout time.Duration) *RunnerClient {
	return &RunnerClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}
}

func (c *RunnerClient) Health(ctx context.Context) (RunnerHealth, error) {
	return doRunnerRequest[RunnerHealth](ctx, c.httpClient, http.MethodGet, c.baseURL+"/health", nil)
}

func (c *RunnerClient) CreateSession(ctx context.Context, input CreateSessionInput) (SessionActionResult, error) {
	return doRunnerRequest[SessionActionResult](ctx, c.httpClient, http.MethodPost, c.baseURL+"/internal/sessions", input)
}

func (c *RunnerClient) GetSession(ctx context.Context, sessionID string) (SessionRecord, error) {
	return doRunnerRequest[SessionRecord](ctx, c.httpClient, http.MethodGet, c.baseURL+"/internal/sessions/"+sessionID, nil)
}

func (c *RunnerClient) ConnectSession(ctx context.Context, sessionID string, input ConnectSessionInput) (SessionConnectionResult, error) {
	return doRunnerRequest[SessionConnectionResult](ctx, c.httpClient, http.MethodPost, c.baseURL+"/internal/sessions/"+sessionID+"/connect", input)
}

func (c *RunnerClient) SendMessage(ctx context.Context, sessionID string, input SendMessageInput) (MessageResult, error) {
	return doRunnerRequest[MessageResult](ctx, c.httpClient, http.MethodPost, c.baseURL+"/internal/sessions/"+sessionID+"/messages", input)
}

func (c *RunnerClient) StreamMessage(ctx context.Context, sessionID string, input SendMessageInput) (MessageStreamResult, error) {
	return doRunnerRequest[MessageStreamResult](ctx, c.httpClient, http.MethodPost, c.baseURL+"/internal/sessions/"+sessionID+"/messages/stream", input)
}

func (c *RunnerClient) StreamMessageEvents(ctx context.Context, sessionID string, input SendMessageInput, onEvent func(RunnerStreamEvent) error) error {
	payload, err := json.Marshal(input)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/internal/sessions/"+sessionID+"/messages/stream", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := fmt.Sprintf("runner request failed with status %d", resp.StatusCode)
		var errBody map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&errBody); err == nil {
			if value, ok := errBody["error"].(string); ok && value != "" {
				message = value
			}
		}
		return &RunnerError{StatusCode: resp.StatusCode, Message: message}
	}

	reader := bufio.NewReader(resp.Body)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		line = strings.TrimRight(line, "\r\n")
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var event RunnerStreamEvent
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
			return err
		}
		if err := onEvent(event); err != nil {
			return err
		}
	}
}

func (c *RunnerClient) CloseSession(ctx context.Context, sessionID string) (SessionActionResult, error) {
	return doRunnerRequest[SessionActionResult](ctx, c.httpClient, http.MethodPost, c.baseURL+"/internal/sessions/"+sessionID+"/close", nil)
}

func (c *RunnerClient) RestartSession(ctx context.Context, sessionID string) (SessionActionResult, error) {
	return doRunnerRequest[SessionActionResult](ctx, c.httpClient, http.MethodPost, c.baseURL+"/internal/sessions/"+sessionID+"/restart", nil)
}

type RunnerError struct {
	StatusCode int
	Message    string
}

func (e *RunnerError) Error() string {
	return e.Message
}

func doRunnerRequest[T any](ctx context.Context, httpClient *http.Client, method string, url string, body any) (T, error) {
	var zero T

	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return zero, err
		}
		reader = bytes.NewReader(payload)
	}

	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return zero, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return zero, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := fmt.Sprintf("runner request failed with status %d", resp.StatusCode)
		var errBody map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&errBody); err == nil {
			if value, ok := errBody["error"].(string); ok && value != "" {
				message = value
			}
		}
		return zero, &RunnerError{StatusCode: resp.StatusCode, Message: message}
	}

	if resp.StatusCode == http.StatusNoContent {
		return zero, nil
	}

	if err := json.NewDecoder(resp.Body).Decode(&zero); err != nil {
		return zero, err
	}

	return zero, nil
}
