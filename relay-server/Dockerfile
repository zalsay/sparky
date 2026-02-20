# Use the pre-built binary
FROM debian:bookworm-slim

# Install OpenSSL
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 appuser

# Copy pre-built binary
COPY target/release/relay-server /usr/local/bin/relay-server

# Make executable
RUN chmod +x /usr/local/bin/relay-server

# Create non-root user
USER appuser

# Expose port
EXPOSE 8005

# Run the server
ENTRYPOINT ["relay-server", "--port", "8005"]
