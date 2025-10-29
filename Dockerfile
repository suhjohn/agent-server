FROM node:22-slim

# Install all system dependencies in a single layer
RUN apt-get update && \
    apt-get install -y \
    curl \
    gnupg2 \
    software-properties-common \
    sqlite3 \
    procps \
    bsdextrautils \
    sudo \
    python3 \
    python3-pip \
    python3-venv \
    redis-server \
    iproute2 \
    iputils-ping \
    telnet \
    openssh-server \
    git \
    ripgrep && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y gh && \
    curl -LsSf https://astral.sh/uv/install.sh | sh && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* && \
    npm install -g npm@latest && \
    npm install -g pnpm@latest && \
    userdel -r ubuntu 2>/dev/null || true && \
    mkdir -p /run/sshd && \
    chmod 755 /run/sshd && \
    echo "PasswordAuthentication yes" >> /etc/ssh/sshd_config && \
    echo "PermitRootLogin no" >> /etc/ssh/sshd_config

# Add uv to PATH and verify installations
ENV PATH="/root/.local/bin:/root/.cargo/bin:$PATH"
RUN pnpm --version && /root/.local/bin/uv --version

# Create appuser
RUN useradd -ms /bin/bash appuser -u 1001

# Set root's home directory to /home/appuser and add root to appuser group
RUN usermod -d /home/appuser -g appuser root && \
    userdel -r ubuntu 2>/dev/null || true

WORKDIR /app

COPY . .

# # Copy package files and install dependencies
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# Copy and install llm-server dependencies
COPY llm-server/pyproject.toml llm-server/uv.lock ./llm-server/
RUN cd llm-server && /root/.local/bin/uv sync

# Copy source code and build
RUN chmod +x setup-claude.sh && \
    chmod +x setup-codex.sh && \
    pnpm run build && \
    mkdir -p /home/appuser/workspace /home/appuser/data && \
    chown -R appuser:appuser /home/appuser /app && \
    chmod -R 775 /home/appuser

COPY entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh  

VOLUME ["/home/appuser"]

EXPOSE 22 3000 43123
ENV ANTHROPIC_BASE_URL=http://localhost:8000
ENV PRESERVE_SSH_ON_SHUTDOWN=false

# ENV PRESERVE_SSH_ON_SHUTDOWN=false # If you uncomment this, then you can't start multiple shells from the client.
CMD ["/usr/local/bin/entrypoint.sh"] 