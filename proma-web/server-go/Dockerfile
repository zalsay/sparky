FROM docker.xuanyuan.run/golang:1.24-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/server ./cmd/server

FROM docker.xuanyuan.run/alpine:3.21
WORKDIR /app
COPY --from=builder /out/server /app/server
COPY config.yaml /app/config.yaml
EXPOSE 3010
CMD ["/app/server"]
