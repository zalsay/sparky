package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/sparky-proma/server/internal/api"
	"github.com/sparky-proma/server/internal/config"
	"github.com/sparky-proma/server/internal/db"
	"github.com/sparky-proma/server/internal/store"
)

func main() {
	cfg := config.Load()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	database, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}

	var backingStore store.Store = store.NewMemoryStore()
	if database != nil && database.Conn != nil && database.Status.Connected {
		backingStore = store.NewPostgresStore(database.Conn)
		log.Printf("using PostgreSQL store")
	} else {
		log.Printf("using memory store")
	}

	server := api.NewServer(cfg, database, backingStore)

	log.Printf("sparky server listening on :%s", cfg.Port)
	if err := http.ListenAndServe(":"+cfg.Port, server.Handler()); err != nil {
		log.Fatal(err)
	}
}
