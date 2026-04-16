FROM docker.xuanyuan.run/library/node:24-bookworm-slim AS node-runtime


FROM docker.xuanyuan.run/library/python:3.12-bookworm AS python-runtime


FROM docker.xuanyuan.run/library/golang:1.26-bookworm AS go-runtime


FROM docker.xuanyuan.run/library/rust:1.90-bookworm AS rust-build

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALL_PROXY
ARG NO_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} HTTPS_PROXY=${HTTPS_PROXY} ALL_PROXY=${ALL_PROXY} NO_PROXY=${NO_PROXY}

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY .cargo ./.cargo
RUN mkdir -p src && \
    printf 'fn main() {}\n' > src/main.rs && \
    cargo build --release && \
    rm -rf src

COPY src ./src
RUN find src -type f -exec touch {} + && \
    cargo build --release --bins


FROM cc-dev-rust:latest AS legacy-code-server


FROM docker.xuanyuan.run/library/debian:bookworm-slim AS runtime-base

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALL_PROXY
ARG NO_PROXY
ARG APT_PRIMARY_MIRROR=http://mirrors.ustc.edu.cn/debian
ARG APT_SECURITY_MIRROR=http://mirrors.ustc.edu.cn/debian-security
ENV HTTP_PROXY=${HTTP_PROXY} HTTPS_PROXY=${HTTPS_PROXY} ALL_PROXY=${ALL_PROXY} NO_PROXY=${NO_PROXY}

RUN printf 'Types: deb\nURIs: %s\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: %s\nSuites: bookworm-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' "$APT_PRIMARY_MIRROR" "$APT_SECURITY_MIRROR" > /etc/apt/sources.list.d/debian.sources && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        git \
        gosu \
        openssh-client \
        tzdata && \
    rm -rf /var/lib/apt/lists/*

RUN groupadd -g 1000 app && useradd -u 1000 -g app -m -s /bin/bash app
RUN mkdir -p /app /projects /home/app/.ssh /home/app/go /app/web-dist && chown -R app:app /projects /home/app/.ssh /home/app/go /app

WORKDIR /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENV HOME=/home/app
ENV USER=app
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]


FROM runtime-base AS server-runtime

COPY --from=rust-build /src/target/release/sparky /usr/local/bin/sparky

ENV SPARKY_COMMAND=/usr/local/bin/sparky

EXPOSE 3001


FROM runtime-base AS executor-runtime

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALL_PROXY
ARG NO_PROXY
ARG APT_PRIMARY_MIRROR=http://mirrors.ustc.edu.cn/debian
ARG APT_SECURITY_MIRROR=http://mirrors.ustc.edu.cn/debian-security
ENV HTTP_PROXY=${HTTP_PROXY} HTTPS_PROXY=${HTTPS_PROXY} ALL_PROXY=${ALL_PROXY} NO_PROXY=${NO_PROXY}

RUN printf 'Types: deb\nURIs: %s\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: %s\nSuites: bookworm-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' "$APT_PRIMARY_MIRROR" "$APT_SECURITY_MIRROR" > /etc/apt/sources.list.d/debian.sources && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        bubblewrap \
        chromium \
        curl \
        default-mysql-client \
        file \
        lsof \
        pkg-config \
        ripgrep && \
    rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/bin /usr/local/bin
COPY --from=node-runtime /usr/local/include /usr/local/include
COPY --from=node-runtime /usr/local/lib /usr/local/lib
COPY --from=node-runtime /usr/local/share /usr/local/share
COPY --from=python-runtime /usr/local/bin /usr/local/bin
COPY --from=python-runtime /usr/local/include /usr/local/include
COPY --from=python-runtime /usr/local/lib /usr/local/lib
COPY --from=python-runtime /usr/local/share /usr/local/share
COPY --from=go-runtime /usr/local/go /usr/local/go
COPY --from=legacy-code-server /usr/local/lib/code-server-4.114.1 /usr/local/lib/code-server-4.114.1
COPY --from=rust-build /src/target/release/sparky-executor /usr/local/bin/sparky-executor
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-factor 2 && \
    npm config set fetch-retry-mintimeout 10000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set proxy "${HTTP_PROXY}" && \
    npm config set https-proxy "${HTTPS_PROXY}" && \
    for attempt in 1 2 3; do \
        npm install -g @anthropic-ai/claude-code@latest @openai/codex@latest chrome-devtools-mcp@latest && break; \
        if [ "$attempt" -eq 3 ]; then exit 1; fi; \
        sleep 5; \
    done && \
    mkdir -p /home/app/.npm && \
    chown -R app:app /home/app/.npm
RUN ln -sf /usr/local/lib/code-server-4.114.1/bin/code-server /usr/local/bin/code-server
RUN mkdir -p /opt/sparky/code-server/default-extensions && \
    for attempt in 1 2 3; do \
        code-server \
            --install-extension MS-CEINTL.vscode-language-pack-zh-hans \
            --extensions-dir /opt/sparky/code-server/default-extensions \
            --force && break; \
        if [ "$attempt" -eq 3 ]; then \
            echo "warning: failed to install code-server zh-hans extension during build" >&2; \
            break; \
        fi; \
        sleep 5; \
    done
RUN printf '%s\n' \
    'export GOROOT=/usr/local/go' \
    'export GOPATH=${GOPATH:-/home/app/go}' \
    'case ":$PATH:" in' \
    '  *:/usr/local/go/bin:*) ;;' \
    '  *) export PATH=/usr/local/go/bin:$PATH ;;' \
    'esac' \
    > /etc/profile.d/sp-dev-env.sh && chmod 0644 /etc/profile.d/sp-dev-env.sh

ENV GOROOT=/usr/local/go
ENV GOPATH=/home/app/go
ENV PATH=/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV SPARKY_COMMAND=/usr/local/bin/sparky-executor

EXPOSE 3002
