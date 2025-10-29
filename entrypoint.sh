# entrypoint.sh
# Most logic is here because the way Railway works is that when a volume is mounted initially, all files from the Dockerfile get removed. 
#!/bin/sh

# Fail fast on errors and undefined vars
set -eu

# --- CONFIGURABLE PATHS ---
HOME_DIR="/home/appuser"
DATA_DIR="${HOME_DIR}/data"           # Stateful: SQLite database and other data

# --- PROCESS MANAGEMENT ---
SSHD_PID=""
APP_PID=""
LLM_SERVER_PID=""

# Set to "true" to keep SSH running during graceful shutdown
: ${PRESERVE_SSH_ON_SHUTDOWN:="true"}

setup_ssh() {
  # Use appuser for SSH access
  SSH_USERNAME="appuser"
  : ${SSH_PASSWORD:="sshpassword"}

  # Set root password if root login is enabled
  : ${ROOT_PASSWORD:=""}
  if [ -n "$ROOT_PASSWORD" ]; then
      echo "root:$ROOT_PASSWORD" | chpasswd
      echo "Root password set"
  else
      echo "Root password not set"
  fi

  # Set authorized keys if applicable
  : ${AUTHORIZED_KEYS:=""}

  # Check if SSH_PASSWORD is empty and raise an error
  if [ -z "$SSH_PASSWORD" ]; then
      echo "Error: SSH_PASSWORD must be set." >&2
      exit 1
  fi

  # Configure appuser for SSH access
  echo "Configuring appuser for SSH access"
  usermod -s /bin/bash appuser
  usermod -aG sudo appuser
  
  # Grant passwordless sudo (root privileges) to appuser
  echo "appuser ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/appuser
  chmod 440 /etc/sudoers.d/appuser
  
  # Set password for appuser
  echo "appuser:$SSH_PASSWORD" | chpasswd

  # Set the authorized keys from the AUTHORIZED_KEYS environment variable (if provided)
  if [ -n "$AUTHORIZED_KEYS" ]; then
      mkdir -p /home/appuser/.ssh
      echo "$AUTHORIZED_KEYS" > /home/appuser/.ssh/authorized_keys
      chown -R appuser:appuser /home/appuser/.ssh
      chmod 700 /home/appuser/.ssh
      chmod 600 /home/appuser/.ssh/authorized_keys
      echo "Authorized keys set for appuser"
      # Disable password authentication if authorized keys are provided
      sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
  else
      echo "Authorized keys not set"
  fi

  # Start the SSH server
  echo "Starting SSH server..."
  
  /usr/sbin/sshd -D &
  SSHD_PID=$!
}

# Configure and optionally start SSHD before app services
setup_ssh

# Configure git to use GITHUB_TOKEN if available
if [ ! -z "${GITHUB_TOKEN:-}" ]; then
    echo "Configuring git to use GITHUB_TOKEN..."
    su appuser -c "git config --global url.'https://token:${GITHUB_TOKEN}@github.com/'.insteadOf 'https://github.com/'"
    echo "✅ Git configured for GitHub authentication"
else
    echo "No GITHUB_TOKEN found, skipping git configuration"
fi

# # --- CREATE STATEFUL DIRECTORIES ---
echo "Creating data directories..."
mkdir -p "$HOME_DIR" || true
mkdir -p "$DATA_DIR" || true
mkdir -p "${HOME_DIR}/redis" || true
mkdir -p "${HOME_DIR}/.local" || true

# The Fly volume mounts with uid/gid 0 and 0755. Fix ownership for runtime use.
chown -R appuser:appuser "$HOME_DIR" || true

# Create workspaces directory as appuser
mkdir -p "${HOME_DIR}/workspaces"
chown -R appuser:appuser "${HOME_DIR}/workspaces"

# install required global npm CLIs
npm install -g npm@latest pnpm @anthropic-ai/claude-code @openai/codex
npm install -g opencode-ai


# Switch to appuser for the Node.js application
if [ "$(id -u)" -eq 0 ]; then
  echo "Switching to appuser for Node.js application..."

  # Run Claude setup as appuser
  echo "Running Claude setup..."
  su appuser -c "cd /app && /app/setup-claude.sh"

  # Run Codex setup as appuser
  echo "Running Codex setup..."
  su appuser -c "cd /app && /app/setup-codex.sh"

  # Start Redis as appuser
  echo "Starting Redis server..."
  su appuser -c "redis-server --daemonize yes --dir ${HOME_DIR}/redis --logfile ${HOME_DIR}/redis/redis.log"
  sleep 2

  # Run database migrations as appuser
  echo "Checking if database migrations are needed..."
  if su appuser -c "cd /app && pnpm run db:generate --check" 2>/dev/null; then
    echo "✅ Database schema is up to date, skipping migrations"
  else
    echo "Running database migrations..."
    su appuser -c "cd /app && pnpm run db:migrate"
    echo "✅ Database migrations completed"
  fi

  # Start the LLM server as appuser
  echo "Starting LLM server..."
  cd /app/llm-server && /root/.local/bin/uv run python main.py &
  LLM_SERVER_PID=$!
  sleep 2

  # Start the Node.js application as appuser
  echo "Starting Node.js application..."
  su appuser -c "cd /app && pnpm start" &
  APP_PID=$!
else
  # Already running as appuser
  echo "✓ Running as $(whoami)"

  # Start Redis
  echo "Starting Redis server..."
  redis-server --daemonize yes --dir ${HOME_DIR}/redis --logfile ${HOME_DIR}/redis/redis.log
  sleep 2

  # Run Claude setup at runtime
  echo "Running Claude setup..."
  /app/setup-claude.sh

  echo "Checking if database migrations are needed..."
  if pnpm run db:generate --check 2>/dev/null; then
    echo "✅ Database schema is up to date, skipping migrations"
  else
    echo "Running database migrations..."
    pnpm run db:migrate
    echo "✅ Database migrations completed"
  fi

  # Start the LLM server in the background
  echo "Starting LLM server..."
  cd /app/llm-server && /root/.local/bin/uv run python main.py &
  LLM_SERVER_PID=$!
  sleep 2
  cd /app

  # Start the Node.js application in the background
  echo "Starting Node.js application..."
  pnpm start &
  APP_PID=$!
fi


# Function to handle shutdown
cleanup() {
  echo "Shutting down application services..."
  
  # Kill application processes
  if [ -n "$LLM_SERVER_PID" ]; then
    echo "Stopping LLM server (PID: $LLM_SERVER_PID)..."
    kill $LLM_SERVER_PID 2>/dev/null || true
  fi
  
  if [ -n "$APP_PID" ]; then
    echo "Stopping Node.js application (PID: $APP_PID)..."
    kill $APP_PID 2>/dev/null || true
  fi
  
  # Handle SSH based on configuration
  if [ "$PRESERVE_SSH_ON_SHUTDOWN" = "true" ]; then
    echo "SSH server preserved (PID: $SSHD_PID) - container will keep running for SSH access"
    # Don't exit - keep container alive for SSH
    echo "Application services stopped. SSH remains available on port 22."
    echo "To fully stop the container, set PRESERVE_SSH_ON_SHUTDOWN=false"
    
    # Keep the container alive by waiting indefinitely
    while true; do
      sleep 30
      # Check if SSH is still running
      if [ -n "$SSHD_PID" ] && ! kill -0 $SSHD_PID 2>/dev/null; then
        echo "SSH server died, exiting..."
        exit 1
      fi
    done
  else
    echo "Stopping SSH server (PID: $SSHD_PID)..."
    if [ -n "$SSHD_PID" ]; then
      kill $SSHD_PID 2>/dev/null || true
    fi
    echo "All services stopped"
    exit 0
  fi
}

# Set up signal handlers
trap cleanup TERM INT

# Function to wait for multiple processes and handle restarts
wait_for_processes() {
  echo "Monitoring application processes..."
  echo "SSH PID: $SSHD_PID"
  echo "LLM Server PID: $LLM_SERVER_PID"
  echo "App PID: $APP_PID"
  
  while true; do
    # Check if LLM server is still running
    if [ -n "$LLM_SERVER_PID" ] && ! kill -0 $LLM_SERVER_PID 2>/dev/null; then
      echo "⚠️ LLM server (PID: $LLM_SERVER_PID) has stopped"
      
      if [ "$PRESERVE_SSH_ON_SHUTDOWN" = "true" ]; then
        echo "SSH preserved - container continues running"
        echo "You can SSH in to restart LLM server or debug issues"
        # Remove the dead PID reference
        LLM_SERVER_PID=""
      else
        echo "LLM server stopped, initiating shutdown..."
        cleanup
      fi
    fi
    
    # Check if main application is still running
    if [ -n "$APP_PID" ] && ! kill -0 $APP_PID 2>/dev/null; then
      echo "⚠️ Node.js application (PID: $APP_PID) has stopped"
      
      if [ "$PRESERVE_SSH_ON_SHUTDOWN" = "true" ]; then
        echo "SSH preserved - container continues running"
        echo "You can SSH in to restart services or debug issues"
        # Remove the dead PID reference
        APP_PID=""
      else
        echo "Application stopped, initiating shutdown..."
        cleanup
      fi
    fi
    
    # Check if SSH is still running (critical for access)
    if [ -n "$SSHD_PID" ] && ! kill -0 $SSHD_PID 2>/dev/null; then
      echo "⚠️ SSH server (PID: $SSHD_PID) has stopped - this is critical!"
      echo "Container will exit as SSH access is lost"
      exit 1
    fi
    
    
    # Sleep before next check
    sleep 10
  done
}

# Start monitoring processes
wait_for_processes 