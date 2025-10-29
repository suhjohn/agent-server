#!/bin/sh

# Exit on any error
set -e

# Determine the home directory
HOME_DIR="/home/appuser"

# Setup Claude configuration from template
if [ -f "/app/claude-config-template.json" ]; then
  # !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
  # ⚠️  CRITICAL: CHECK IF .claude.json ALREADY EXISTS - DO NOT OVERWRITE! ⚠️
  # !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
  # 🛑 THIS IS EXTREMELY IMPORTANT - WE MUST PRESERVE EXISTING CONFIGURATIONS 🛑
  # !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
  if [ -f "${HOME_DIR}/.claude.json" ]; then
    echo "⚠️  IMPORTANT: Claude configuration already exists at ${HOME_DIR}/.claude.json"
    echo "🛑 SKIPPING CREATION TO PRESERVE EXISTING CONFIGURATION 🛑"
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  else
    # ✅ SAFE TO PROCEED - NO EXISTING CONFIG FOUND
    # Start with the template
    cp /app/claude-config-template.json /tmp/claude-config.json
    
    # Process API key if provided
    if [ -n "$ANTHROPIC_API_KEY" ]; then
      # Get the last 20 characters of the API key
      API_KEY_SUFFIX=$(echo "$ANTHROPIC_API_KEY" | tail -c 21)
      
      # Replace placeholders with actual values
      sed -i "s/__API_KEY__/$ANTHROPIC_API_KEY/g" /tmp/claude-config.json
      sed -i "s/__API_KEY_SUFFIX__/$API_KEY_SUFFIX/g" /tmp/claude-config.json
      
      echo "Claude configuration created with API key"
      
    else
      # Remove primaryApiKey field and clear customApiKeyResponses if no API key provided
      node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('/tmp/claude-config.json', 'utf8'));

// Remove primaryApiKey field
delete config.primaryApiKey;

// Clear the customApiKeyResponses since we don't have an API key
if (config.customApiKeyResponses) {
  config.customApiKeyResponses = {
    approved: [],
    rejected: []
  };
}

fs.writeFileSync('/tmp/claude-config.json', JSON.stringify(config, null, 2));
"
      echo "Claude configuration created without API key"
    fi
    
    # Move the final config to the correct location
    mv /tmp/claude-config.json ${HOME_DIR}/.claude.json
    echo "Claude configuration created at ${HOME_DIR}/.claude.json"
  fi
  # !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
  # END OF CRITICAL SECTION - .claude.json CREATION/SKIP LOGIC
  # !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
  
  # Setup credentials file if enabled
  mkdir -p ${HOME_DIR}/.claude
  
  # Check if we should use the credentials file
  if [ "$USE_CLAUDE_CREDENTIALS" = "true" ] && [ -f "/app/claude-credentials.json" ]; then
    # !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
    # ⚠️  CRITICAL: CHECK IF credentials.json EXISTS - DO NOT OVERWRITE! ⚠️
    # !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
    if [ -f "${HOME_DIR}/.claude/credentials.json" ]; then
      echo "⚠️  IMPORTANT: Credentials already exist at ${HOME_DIR}/.claude/credentials.json"
      echo "🛑 SKIPPING COPY TO PRESERVE EXISTING CREDENTIALS 🛑"
    else
      cp /app/claude-credentials.json ${HOME_DIR}/.claude/credentials.json
      echo "Credentials copied to ${HOME_DIR}/.claude/credentials.json"
    fi
    
    # Only merge customApiKeyResponses if .claude.json was just created
    if [ ! -f "${HOME_DIR}/.claude.json" ]; then
      # Extract customApiKeyResponses from credentials and merge into Claude config
      node -e "
const fs = require('fs');
const path = require('path');

const homeDir = process.env.HOME || '/home/appuser';

try {
  // Read the credentials file
  const credentials = JSON.parse(fs.readFileSync('/app/claude-credentials.json', 'utf8'));
  
  // Read the current Claude config
  const config = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf8'));
  
  // Extract customApiKeyResponses if it exists in credentials
  if (credentials.customApiKeyResponses) {
    config.customApiKeyResponses = credentials.customApiKeyResponses;
    console.log('Merged customApiKeyResponses from credentials into Claude config');
  }
  
  // Write the updated config back
  fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify(config, null, 2));
} catch (e) {
  console.log('Warning: Failed to merge customApiKeyResponses:', e.message);
}
"
    fi
    
  elif [ "$USE_CLAUDE_CREDENTIALS" = "true" ]; then
    echo "Warning: USE_CLAUDE_CREDENTIALS=true but /app/claude-credentials.json not found"
  else
    echo "Claude credentials file not used"
  fi
else
  echo "No Claude configuration template found"
fi 