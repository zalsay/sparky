package config

import (
	"fmt"
	"net/url"
	"os"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Port        string
	DatabaseURL string
	Environment string
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
		port = "8080"
	}

	environment := os.Getenv("APP_ENV")
	if environment == "" {
		environment = "development"
	}

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		databaseURL = loadDatabaseURLFromFile("config.yaml")
	}

	return Config{
		Port:        port,
		DatabaseURL: databaseURL,
		Environment: environment,
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
