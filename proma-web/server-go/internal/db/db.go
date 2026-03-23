package db

import (
	"context"
	"database/sql"
	_ "github.com/lib/pq"
)

type Status struct {
	Configured bool
	Connected  bool
}

type DB struct {
	Conn   *sql.DB
	Status Status
}

func Open(ctx context.Context, databaseURL string) (*DB, error) {
	if databaseURL == "" {
		return &DB{Status: Status{Configured: false, Connected: false}}, nil
	}

	conn, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return nil, err
	}

	if err := conn.PingContext(ctx); err != nil {
		_ = conn.Close()
		return nil, err
	}

	return &DB{
		Conn: conn,
		Status: Status{
			Configured: true,
			Connected:  true,
		},
	}, nil
}
