.PHONY: build run clean docker-build docker-run docker-stop

# Build settings
TARGET = relay-server
RELEASE_DIR = target/release
DEBUG_DIR = target/debug

# Default target
all: build

# Build for release
build:
	cargo build --release

# Build for debug
build-debug:
	cargo build

# Run in development mode
run:
	cargo run

# Clean build artifacts
clean:
	cargo clean
	rm -f $(TARGET)

# Install dependencies
deps:
	cargo fetch

# Check code without building
check:
	cargo check

# Format code
fmt:
	cargo fmt

# Lint code
lint:
	cargo clippy -- -D warnings

# Build static binary for Linux
build-static:
	cargo build --release --target x86_64-unknown-linux-gnu

# Default port
PORT ?= 8005

# Run the built binary
start:
	./$(RELEASE_DIR)/$(TARGET) --port $(PORT)

# Run in background
start-bg:
	nohup ./$(RELEASE_DIR)/$(TARGET) --port $(PORT) > $(TARGET).log 2>&1 &

# Stop the server
stop:
	pkill -f $(TARGET) || true

# Docker build
docker-build:
	docker build -t sparky-relay:latest .

# Docker run
docker-run:
	docker run -d --name sparky-relay -p $(PORT):$(PORT) sparky-relay:latest

# Docker stop
docker-stop:
	docker stop sparky-relay || true
	docker rm sparky-relay || true
