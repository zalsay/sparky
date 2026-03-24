package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Port                 string
	DatabaseURL          string
	Environment          string
	AgentRunnerBaseURL   string
	AgentControlEnabled  bool
	AgentDefaultRunnerID string
	AgentRunnerTimeout   time.Duration
}

type fileConfig struct {
	Database struct {
		Host     string `yaml:"host"`
		Port     int    `yaml:"port"`
		Prot     int    `yaml:"prot"`
		User     string `yaml:"user"`
		Password string `yaml:"password"`
		Name     string `yaml:"database"`
		SSLMode  string `yaml:"sslmode"`
	} `yaml:"database"`
}

func Load() Config {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3010"
	}

	environment := os.Getenv("APP_ENV")
	if environment == "" {
		environment = "development"
	}

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		databaseURL = loadDatabaseURLFromFile("config.yaml")
	}

	agentRunnerBaseURL := os.Getenv("AGENT_RUNNER_BASE_URL")
	agentControlEnabled := agentRunnerBaseURL != ""

	agentDefaultRunnerID := os.Getenv("AGENT_DEFAULT_RUNNER_ID")
	if agentDefaultRunnerID == "" {
		agentDefaultRunnerID = "default"
	}

	agentRunnerTimeout := 5 * time.Second
	if value := os.Getenv("PROMA_AGENT_RUNNER_TIMEOUT_MS"); value != "" {
		if timeoutMS, err := strconv.Atoi(value); err == nil && timeoutMS > 0 {
			agentRunnerTimeout = time.Duration(timeoutMS) * time.Millisecond
		}
	}

	return Config{
		Port:                 port,
		DatabaseURL:          databaseURL,
		Environment:          environment,
		AgentRunnerBaseURL:   agentRunnerBaseURL,
		AgentControlEnabled:  agentControlEnabled,
		AgentDefaultRunnerID: agentDefaultRunnerID,
		AgentRunnerTimeout:   agentRunnerTimeout,
	}
}

func loadDatabaseURLFromFile(path string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		return ""
	}

	var cfg fileConfig
	if err := yaml.Unmarshal(content, &cfg); err != nil {
		return ""
	}

	host := cfg.Database.Host
	if host == "" {
		return ""
	}

	port := cfg.Database.Port
	if port == 0 {
		port = cfg.Database.Prot
	}
	if port == 0 {
		port = 5432
	}

	user := cfg.Database.User
	name := cfg.Database.Name
	if user == "" || name == "" {
		return ""
	}

	sslmode := cfg.Database.SSLMode
	if sslmode == "" {
		sslmode = "disable"
	}

	return fmt.Sprintf(
		"postgres://%s:%s@%s:%d/%s?sslmode=%s",
		url.QueryEscape(user),
		url.QueryEscape(cfg.Database.Password),
		host,
		port,
		url.PathEscape(name),
		url.QueryEscape(sslmode),
	)
}
